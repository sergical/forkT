import { FORK_TRACED_RPCS } from "@t3tools/shared/forkSentry";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

/**
 * T3 fork: which spans reach Sentry (the local trace file keeps all). A trace is decided when its
 * root ends; one that outlives `maxBufferMs` streams only failed, slow and agent spans, and their
 * open ancestors follow when they end so the waterfall stays whole.
 */
export interface ForkTracePolicy {
  /** Spans shorter than this are dropped from a kept trace unless they failed. */
  readonly minSpanMs: number;
  /** A trace whose root takes this long is kept; in streaming traces, spans this slow are sent. */
  readonly slowMs: number;
  readonly baselineRate: number;
  readonly maxBufferMs: number;
  readonly maxBufferedSpans: number;
  /** Polling loops: their whole subtree is dropped unless a span in it fails. */
  readonly pollSpanNames: ReadonlySet<string>;
  /** Spans that make their trace worth keeping and are always sent. */
  readonly alwaysPrefixes: ReadonlyArray<string>;
  readonly spanAttributes?: Readonly<Record<string, unknown>>;
}

export const defaultForkTracePolicy: ForkTracePolicy = {
  minSpanMs: 10,
  slowMs: 300,
  baselineRate: 0.01,
  maxBufferMs: 30_000,
  maxBufferedSpans: 2_000,
  pollSpanNames: new Set([
    "ClaudeAgentSdkQueryRunner.trackDescendants",
    "ws.rpc.server.reportClientActivity",
    "terminal.pollSubprocessActivity",
  ]),
  alwaysPrefixes: [
    "invoke_agent ",
    "chat ",
    "execute_tool ",
    "fork.",
    ...FORK_TRACED_RPCS.map((rpc) => `ws.rpc.${rpc}`),
  ],
};

interface TraceState {
  readonly root: SampledSpan;
  readonly buffered: Array<SampledSpan>;
  streaming: boolean;
  failed: boolean;
  always: boolean;
}

const isFailure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause);

class SampledSpan implements Tracer.Span {
  readonly _tag = "Span";
  readonly inner: Tracer.Span;
  readonly parentSpan: SampledSpan | undefined;
  readonly startTime: bigint;
  readonly trace: TraceState;
  readonly suppressed: boolean;
  always: boolean;
  keepForDescendant = false;
  endTime: bigint | undefined;
  exit: Exit.Exit<unknown, unknown> | undefined;

  constructor(
    inner: Tracer.Span,
    parentSpan: SampledSpan | undefined,
    startTime: bigint,
    trace: TraceState | undefined,
    policy: ForkTracePolicy,
  ) {
    this.inner = inner;
    this.parentSpan = parentSpan;
    this.startTime = startTime;
    this.always = policy.alwaysPrefixes.some((prefix) => inner.name.startsWith(prefix));
    this.suppressed = policy.pollSpanNames.has(inner.name) || (parentSpan?.suppressed ?? false);
    this.trace = trace ?? {
      root: this,
      buffered: [],
      streaming: false,
      failed: false,
      always: false,
    };
    if (this.always) this.trace.always = true;
  }

  get name() {
    return this.inner.name;
  }
  get spanId() {
    return this.inner.spanId;
  }
  get traceId() {
    return this.inner.traceId;
  }
  get parent() {
    return this.inner.parent;
  }
  get annotations() {
    return this.inner.annotations;
  }
  get status() {
    return this.inner.status;
  }
  get attributes() {
    return this.inner.attributes;
  }
  get links() {
    return this.inner.links;
  }
  get sampled() {
    return this.inner.sampled;
  }
  get kind() {
    return this.inner.kind;
  }
  get durationMs() {
    return this.endTime === undefined ? 0 : Number(this.endTime - this.startTime) / 1e6;
  }
  get failed() {
    return this.exit !== undefined && isFailure(this.exit);
  }

  attribute(key: string, value: unknown) {
    this.inner.attribute(key, value);
    if (key === "sentry.op" && typeof value === "string" && value.startsWith("fork.")) {
      this.always = true;
      this.trace.always = true;
    }
  }
  event(name: string, startTime: bigint, attributes?: Record<string, unknown>) {
    this.inner.event(name, startTime, attributes);
  }
  addLinks(links: ReadonlyArray<Tracer.SpanLink>) {
    this.inner.addLinks(links);
  }
  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
    this.endTime = endTime;
    this.exit = exit;
    this.onEnd(this);
  }
  onEnd: (span: SampledSpan) => void = () => {};
}

export const make = (
  delegate: Tracer.Tracer,
  policy: ForkTracePolicy = defaultForkTracePolicy,
  random: () => number = Math.random,
): Tracer.Tracer => {
  const open = new Map<string, SampledSpan>();

  const send = (span: SampledSpan) => {
    span.inner.end(span.endTime!, span.exit!);
    for (let ancestor = span.parentSpan; ancestor !== undefined; ancestor = ancestor.parentSpan) {
      if (ancestor.keepForDescendant) break;
      ancestor.keepForDescendant = true;
    }
  };

  const worthStreaming = (span: SampledSpan) =>
    span.failed ||
    span.always ||
    span.keepForDescendant ||
    (!span.suppressed && span.durationMs >= policy.slowMs);

  const startStreaming = (trace: TraceState) => {
    trace.streaming = true;
    for (const span of trace.buffered.splice(0)) if (worthStreaming(span)) send(span);
  };

  const onEnd = (span: SampledSpan) => {
    open.delete(span.spanId);
    const trace = span.trace;
    if (span.failed) trace.failed = true;
    if (
      !trace.streaming &&
      (Number(span.endTime! - trace.root.startTime) / 1e6 > policy.maxBufferMs ||
        trace.buffered.length >= policy.maxBufferedSpans)
    ) {
      startStreaming(trace);
    }
    if (trace.streaming) {
      if (worthStreaming(span)) send(span);
      return;
    }
    if (span !== trace.root) {
      trace.buffered.push(span);
      return;
    }
    const keep =
      trace.failed ||
      trace.always ||
      span.durationMs >= policy.slowMs ||
      random() < policy.baselineRate;
    const buffered = trace.buffered.splice(0);
    // Work the root started may outlive it: from now on its spans go out like a long trace's.
    trace.streaming = true;
    if (!keep) return;
    for (const child of buffered) {
      if (
        child.failed ||
        child.always ||
        child.keepForDescendant ||
        (!child.suppressed && child.durationMs >= policy.minSpanMs)
      ) {
        send(child);
      }
    }
    send(span);
  };

  return Tracer.make({
    span(options) {
      const inner = delegate.span(options);
      for (const [key, value] of Object.entries(policy.spanAttributes ?? {})) {
        inner.attribute(key, value);
      }
      const parentId = Option.getOrUndefined(options.parent)?.spanId;
      const parentSpan = parentId === undefined ? undefined : open.get(parentId);
      const span = new SampledSpan(inner, parentSpan, options.startTime, parentSpan?.trace, policy);
      span.onEnd = onEnd;
      open.set(span.spanId, span);
      return span;
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
};
