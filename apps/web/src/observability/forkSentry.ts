import * as Sentry from "@sentry/react";
import {
  FORK_SENTRY_DSN,
  FORK_TRACED_RPCS,
  forkSentryEnabled as isForkSentryEnabled,
} from "@t3tools/shared/forkSentry";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import { APP_VERSION } from "../branding";
import { isElectron } from "../env";

/** T3 fork: Sentry for the web client, in fork builds or with `VITE_T3_FORK_SENTRY=1`. */
export const forkSentryEnabled = isForkSentryEnabled(
  import.meta.env.VITE_T3_FORK_SENTRY,
  APP_VERSION,
);

// Every client trace is sampled so the server decides on its own spans; filterTransaction decides
// what the browser sends.
const SLOW_TRANSACTION_SECONDS = 1;
// A kept transaction leaves out spans shorter than this unless they failed or lead to one kept.
const MIN_SPAN_MS = 10;
// Heartbeats: frequent, and slow only when the machine is.
const POLL_TRANSACTIONS = new Set(["web.backgroundActivity.report", "server.reportClientActivity"]);
// Past this age a transaction's new children start their own transaction in the same trace, so a
// subscription that lives for hours does not hold every span it ever had.
const MAX_TRANSACTION_AGE_NS = 30_000_000_000n;

type TransactionEvent = Parameters<NonNullable<Sentry.BrowserOptions["beforeSendTransaction"]>>[0];

const failedStatus = (status: string | undefined) =>
  status !== undefined && status !== "ok" && status !== "unknown";
const isTracedRpc = (name: string | undefined) =>
  name !== undefined && FORK_TRACED_RPCS.includes(name);

/** Keeps page loads, failures, slow work and user actions, without their short successful spans. */
export function filterTransaction(event: TransactionEvent): TransactionEvent | null {
  const trace = event.contexts?.trace;
  const spans = event.spans ?? [];
  const tracedRpc = (span: (typeof spans)[number]) =>
    span.op === "rpc.client" && isTracedRpc(span.description);
  const failed = failedStatus(trace?.status) || spans.some((span) => failedStatus(span.status));
  const userAction = isTracedRpc(event.transaction) || spans.some(tracedRpc);
  const seconds = (event.timestamp ?? 0) - (event.start_timestamp ?? 0);
  if (!failed && !userAction) {
    if (event.transaction !== undefined && POLL_TRANSACTIONS.has(event.transaction)) return null;
    const pageChange = trace?.op === "pageload" || trace?.op === "navigation";
    if (!pageChange && seconds < SLOW_TRANSACTION_SECONDS) return null;
  }
  const byId = new Map(spans.map((span) => [span.span_id, span]));
  const kept = new Set<string>();
  for (const span of spans) {
    const ms = ((span.timestamp ?? span.start_timestamp) - span.start_timestamp) * 1000;
    if (!failedStatus(span.status) && !tracedRpc(span) && ms < MIN_SPAN_MS) continue;
    for (
      let current: (typeof spans)[number] | undefined = span;
      current !== undefined && !kept.has(current.span_id);
      current = current.parent_span_id === undefined ? undefined : byId.get(current.parent_span_id)
    ) {
      kept.add(current.span_id);
    }
  }
  return { ...event, spans: spans.filter((span) => kept.has(span.span_id)) };
}

export function initForkSentry(): void {
  if (!forkSentryEnabled) return;
  Sentry.init({
    dsn: FORK_SENTRY_DSN.web,
    release: `t3-fork@${APP_VERSION}`,
    environment: import.meta.env.PROD ? "production" : "development",
    initialScope: { tags: { surface: isElectron ? "desktop" : "web" } },
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] }),
    ],
    tracesSampleRate: 1,
    // Whole transactions, so beforeSendTransaction can judge a trace by its root.
    traceLifecycle: "static",
    beforeSendTransaction: filterTransaction,
  });
}

const reportReactError = Sentry.reactErrorHandler();
const onRootError = (error: unknown, info: { readonly componentStack?: string | undefined }) =>
  reportReactError(error, { componentStack: info.componentStack ?? "" });

export const forkSentryRootOptions = forkSentryEnabled
  ? { onUncaughtError: onRootError, onCaughtError: onRootError, onRecoverableError: onRootError }
  : {};

const seconds = (nanos: bigint) => Number(nanos / 1_000n) / 1e6;

const isPrimitive = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const primitiveAttributes = (attributes: Record<string, unknown> | undefined) => {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (isPrimitive(value)) result[key] = value;
  }
  return result;
};

class SentryEffectSpan implements Tracer.Span {
  readonly _tag = "Span";
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly annotations: Tracer.Span["annotations"];
  readonly links: Array<Tracer.SpanLink>;
  readonly sampled = true;
  readonly kind: Tracer.SpanKind;
  readonly sentry: Sentry.Span;
  readonly transactionStart: bigint;
  status: Tracer.SpanStatus;
  attributes = new Map<string, unknown>();

  constructor(
    options: Parameters<Tracer.Tracer["span"]>[0],
    sentry: Sentry.Span,
    transactionStart: bigint,
  ) {
    const context = sentry.spanContext();
    this.name = options.name;
    this.spanId = context.spanId;
    this.traceId = context.traceId;
    this.parent = options.parent;
    this.annotations = options.annotations;
    this.links = [...options.links];
    this.kind = options.kind;
    this.sentry = sentry;
    this.transactionStart = transactionStart;
    this.status = { _tag: "Started", startTime: options.startTime };
  }

  attribute(key: string, value: unknown) {
    this.attributes.set(key, value);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      this.sentry.setAttribute(key, value);
    }
  }
  event(name: string, startTime: bigint, attributes?: Record<string, unknown>) {
    this.sentry.addEvent(name, primitiveAttributes(attributes), seconds(startTime));
  }
  addLinks(links: ReadonlyArray<Tracer.SpanLink>) {
    this.links.push(...links);
  }
  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
    this.status = { _tag: "Ended", startTime: this.status.startTime, endTime, exit };
    live.delete(this.spanId);
    if (Exit.isFailure(exit)) this.sentry.setStatus({ code: 2, message: "internal_error" });
    this.sentry.end(seconds(endTime));
  }
}

const live = new Map<string, SentryEffectSpan>();

/**
 * Effect spans become Sentry spans, so the trace and span ids that Effect RPC sends with each
 * request are Sentry's and the server's spans join the browser's trace.
 */
export const sentryEffectTracer = Tracer.make({
  span(options) {
    const parentId = Option.getOrUndefined(options.parent)?.spanId;
    const parent = parentId === undefined ? undefined : live.get(parentId);
    const spanOptions = {
      name: options.name,
      op: options.kind === "client" ? "rpc.client" : "effect",
      startTime: seconds(options.startTime),
    };
    // A root Effect span starts its own trace; otherwise one trace would grow for the page's life.
    if (parent === undefined) {
      const sentry = Sentry.startNewTrace(() =>
        Sentry.startInactiveSpan({ ...spanOptions, forceTransaction: true }),
      );
      const span = new SentryEffectSpan(options, sentry, options.startTime);
      live.set(span.spanId, span);
      return span;
    }
    const rollOver = options.startTime - parent.transactionStart > MAX_TRANSACTION_AGE_NS;
    const sentry = Sentry.startInactiveSpan({
      ...spanOptions,
      parentSpan: parent.sentry,
      ...(rollOver ? { forceTransaction: true } : {}),
    });
    const span = new SentryEffectSpan(
      options,
      sentry,
      rollOver ? options.startTime : parent.transactionStart,
    );
    live.set(span.spanId, span);
    return span;
  },
});
