import * as Sentry from "@sentry/react";
import { describe, expect, it } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";

import { filterTransaction, sentryEffectTracer } from "./forkSentry";

const start = (name: string, parent?: Tracer.Span, startTime = 1_000_000_000n) =>
  sentryEffectTracer.span({
    name,
    parent: parent === undefined ? Option.none() : Option.some(parent),
    annotations: Context.empty(),
    links: [],
    startTime,
    kind: "internal",
    root: parent === undefined,
    sampled: true,
  });

describe("sentryEffectTracer", () => {
  it("starts a new trace for each root span and keeps children in their parent's trace", () => {
    const first = start("web.thread.open");
    const child = start("EnvironmentRpc.request", first);
    const second = start("web.thread.open");
    expect(child.traceId).toBe(first.traceId);
    expect(second.traceId).not.toBe(first.traceId);
    expect(first.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

const span = (
  span_id: string,
  parent_span_id: string | undefined,
  ms: number,
  extra: { op?: string; description?: string; status?: string } = {},
) => ({
  span_id,
  trace_id: "t",
  start_timestamp: 100,
  timestamp: 100 + ms / 1000,
  data: {},
  origin: "manual",
  ...(parent_span_id === undefined ? {} : { parent_span_id }),
  ...extra,
});

const transaction = (name: string, seconds: number, spans: ReturnType<typeof span>[]) =>
  ({
    type: "transaction",
    transaction: name,
    start_timestamp: 100,
    timestamp: 100 + seconds,
    contexts: { trace: { trace_id: "t", span_id: "root", op: "effect", status: "ok" } },
    spans,
  }) as Parameters<typeof filterTransaction>[0];

describe("filterTransaction", () => {
  it("keeps a fast transaction with a caught child failure, with only the path to it", () => {
    const kept = filterTransaction(
      transaction("EnvironmentRegistry.run", 0.02, [
        span("a", "root", 3),
        span("b", "a", 2, {
          op: "rpc.client",
          description: "vcs.refreshStatus",
          status: "internal_error",
        }),
        span("c", "root", 1),
      ]),
    );
    expect(kept?.spans?.map((s) => s.span_id)).toEqual(["a", "b"]);
  });

  it("keeps a fast user action and its short parents", () => {
    const kept = filterTransaction(
      transaction("EnvironmentRegistry.run", 0.05, [
        span("a", "root", 4),
        span("b", "a", 3, { op: "rpc.client", description: "forkCoordinator.open" }),
      ]),
    );
    expect(kept?.spans?.map((s) => s.span_id)).toEqual(["a", "b"]);
  });

  it("drops fast work and heartbeats", () => {
    expect(filterTransaction(transaction("EnvironmentRegistry.run", 0.2, []))).toBeNull();
    expect(filterTransaction(transaction("web.backgroundActivity.report", 3, []))).toBeNull();
  });
});

describe("transaction rollover", () => {
  it("starts a new transaction in the same trace for children of an old transaction", () => {
    const subscription = start("EnvironmentRpc.subscribe");
    const early = start("EnvironmentRegistry.run", subscription, 2_000_000_000n);
    const late = start("EnvironmentRegistry.run", subscription, 40_000_000_000n);
    expect(early.traceId).toBe(subscription.traceId);
    expect(late.traceId).toBe(subscription.traceId);
    expect(Sentry.getRootSpan((early as unknown as { sentry: Sentry.Span }).sentry)).toBe(
      (subscription as unknown as { sentry: Sentry.Span }).sentry,
    );
    expect(Sentry.getRootSpan((late as unknown as { sentry: Sentry.Span }).sentry)).toBe(
      (late as unknown as { sentry: Sentry.Span }).sentry,
    );
  });
});
