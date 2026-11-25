import * as Sentry from "@sentry/node";
import { FORK_SENTRY_DSN } from "@t3tools/shared/forkSentry";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Schedule from "effect/Schedule";
import * as Tracer from "effect/Tracer";

import * as ServerConfig from "../config.ts";
import packageJson from "../../package.json" with { type: "json" };

/**
 * T3 fork: Sentry Issues and metrics for the server. Traces and logs reach Sentry over OTLP
 * (see cli/config.ts), so the SDK's own tracing stays off and errors are linked to the
 * Effect span that was active when they happened.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (config.forkSentry === undefined) return;
    Sentry.init({
      dsn: FORK_SENTRY_DSN.server,
      release: `t3-fork@${packageJson.version}`,
      environment:
        config.otelEnvironment.resourceAttributes["deployment.environment.name"] ?? "production",
      enableOpenTelemetrySetup: false,
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => Sentry.flush(2_000)));
    yield* bridgeMetrics.pipe(Effect.forkScoped);
  }),
);

// Defects only: RpcServer also reports typed failures, which are expected outcomes.
export const reporter: ErrorReporter.ErrorReporter = {
  [ErrorReporter.TypeId]: ErrorReporter.TypeId,
  report: ({ cause, fiber }) => {
    if (Sentry.getClient() === undefined) return;
    const span = Context.getOption(fiber.context, Tracer.ParentSpan);
    for (const reason of cause.reasons) {
      if (reason._tag !== "Die" || ErrorReporter.isIgnored(reason.defect)) continue;
      Sentry.withScope((scope) => {
        if (span._tag === "Some") {
          const { traceId, spanId } = span.value;
          scope.addEventProcessor((event) => ({
            ...event,
            contexts: { ...event.contexts, trace: { trace_id: traceId, span_id: spanId } },
          }));
        }
        Sentry.captureException(reason.defect);
      });
    }
  },
};

/**
 * Sentry has no OTLP metrics ingest, so Effect's metrics go through the SDK once a minute:
 * counter and frequency deltas as counts, gauges as gauges, histograms as count and average.
 */
const bridgeMetrics = Effect.gen(function* () {
  const previous = new Map<string, { readonly count: number; readonly sum: number }>();
  const delta = (key: string, count: number, sum = 0) => {
    const last = previous.get(key) ?? { count: 0, sum: 0 };
    previous.set(key, { count, sum });
    return { count: count - last.count, sum: sum - last.sum };
  };
  const flush = Effect.gen(function* () {
    for (const metric of yield* Metric.snapshot) {
      const attributes = { ...metric.attributes };
      const key = [
        metric.id,
        ...Object.entries(attributes).map(([name, value]) => `${name}=${value}`),
      ]
        .toSorted()
        .join("|");
      switch (metric.type) {
        case "Counter": {
          const { count } = delta(key, Number(metric.state.count));
          if (count > 0) Sentry.metrics.count(metric.id, count, { attributes });
          break;
        }
        case "Gauge":
          Sentry.metrics.gauge(metric.id, Number(metric.state.value), { attributes });
          break;
        case "Frequency":
          for (const [occurrence, total] of metric.state.occurrences) {
            const { count } = delta(`${key}|${occurrence}`, total);
            if (count > 0) {
              Sentry.metrics.count(metric.id, count, { attributes: { ...attributes, occurrence } });
            }
          }
          break;
        case "Histogram":
        case "Summary": {
          const { count, sum } = delta(key, metric.state.count, metric.state.sum);
          if (count > 0) {
            Sentry.metrics.count(`${metric.id}.count`, count, { attributes });
            Sentry.metrics.gauge(`${metric.id}.avg`, sum / count, { attributes });
          }
          break;
        }
      }
    }
  });
  yield* flush.pipe(Effect.repeat(Schedule.spaced("1 minute")));
});
