import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderTurn,
  OrchestrationV2PlanArtifact,
  OrchestrationV2Run,
  OrchestrationV2StoredEvent,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { hashTelemetryId } from "@t3tools/shared/telemetryId";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

import { privateForkTraces } from "./forkAgentMetadata.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";

/**
 * T3 fork: agent work as Sentry `gen_ai` spans, built from committed orchestration events so every
 * provider is traced the same way. A run continues the trace of the request that sent its message.
 */

const MAX_REMEMBERED = 2_000;
// A safety bound only: traced ids otherwise expire by age, after the stale window.
const MAX_TRACED = 200_000;
const MAX_OPEN_RUNS = 500;
const MAX_INPUT_CHARS = 2_000;
// A terminal update this long after the record finished is a re-save of an old record.
const STALE_UPDATE_MS = 10 * 60_000;

// The request span that committed each user message, so its run can continue that trace.
const origins = new Map<string, Tracer.AnySpan>();
// Off unless fork Sentry runs, so other builds keep nothing per command.
let recording = false;
export const startRecordingOrigins = () => {
  recording = true;
};

const remember = <K, V>(map: Map<K, V>, key: K, value: V, limit = MAX_REMEMBERED) => {
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
};

const isStale = (completedAt: DateTime.Utc, occurredAt: DateTime.Utc) =>
  DateTime.toEpochMillis(occurredAt) - DateTime.toEpochMillis(completedAt) > STALE_UPDATE_MS;

// The outermost span of this process: a request root is always kept, a short commit span is not.
const outermostLocalSpan = (span: Tracer.AnySpan): Tracer.AnySpan => {
  let current = span;
  while (current._tag === "Span" && Option.isSome(current.parent)) {
    const parent = current.parent.value;
    if (parent._tag !== "Span") break;
    current = parent;
  }
  return current;
};

// Runs inside every command commit, whose own span already covers it.
export const recordOrigins = Effect.fnUntraced(function* (
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  if (!recording) return;
  const messageIds = events.flatMap((event) =>
    event.type === "message.updated" && event.payload.role === "user" ? [event.payload.id] : [],
  );
  if (messageIds.length === 0) return;
  const span = yield* Effect.option(Effect.currentParentSpan);
  if (Option.isNone(span)) return;
  const origin = outermostLocalSpan(span.value);
  for (const id of messageIds) remember(origins, id, origin);
});

const nanos = (time: DateTime.Utc) => BigInt(DateTime.toEpochMillis(time)) * 1_000_000n;

const PROVIDER_NAMES: Record<string, string> = {
  claudeAgent: "anthropic",
  codex: "openai",
  grok: "xai",
  cursor: "cursor",
  opencode: "opencode",
};

const providerName = (instanceId: string) =>
  PROVIDER_NAMES[instanceId] ?? PROVIDER_NAMES[instanceId.split(/[:-]/)[0] ?? ""] ?? instanceId;

const clip = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined
    ? undefined
    : text.length > MAX_INPUT_CHARS
      ? `${text.slice(0, MAX_INPUT_CHARS)}…`
      : text;
};

const TERMINAL_RUN = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
const TERMINAL_ITEM = new Set(["completed", "failed", "cancelled", "interrupted"]);
const FAILED = new Set(["failed"]);

const toolName = (item: OrchestrationV2TurnItem): string | undefined => {
  switch (item.type) {
    case "command_execution":
      return "command";
    case "file_change":
      return "file_change";
    case "dynamic_tool":
      return item.toolName ?? "tool";
    case "web_search":
      return "web_search";
    case "file_search":
      return "file_search";
    case "subagent":
      return "subagent";
    default:
      return undefined;
  }
};

interface OpenRun {
  readonly span: Tracer.Span;
  readonly model: string;
  readonly attributes: Record<string, unknown>;
}

export const make = Effect.fnUntraced(function* (environmentId: string) {
  const environmentRef = hashTelemetryId(environmentId);
  // Fork-owned thread IDs such as fork:global:1 repeat on fresh installations.
  const conversationAttributes = (threadId: string) => ({
    "gen_ai.conversation.id": threadId.startsWith("fork:")
      ? hashTelemetryId(JSON.stringify([environmentId, threadId]))
      : threadId,
    ...(threadId.startsWith("fork:dream:") ? {} : { "t3.thread.id": threadId }),
    "t3.environment.ref": environmentRef,
  });
  const tracer = yield* Effect.tracer;
  const privateMetadata = yield* privateForkTraces;
  const drivers = new Map<string, string>();
  const runs = new Map<string, OpenRun>();
  // The spawn transfer is committed before the child reaches its provider.
  const spawnParents = new Map<string, string>();
  // Finished runs, so tools and subagents that end after their run still join it.
  const finished = new Map<string, OpenRun>();
  // Traced ids by event time, kept for as long as an update to them still counts as fresh.
  const traced = new Map<string, number>();
  let now = 0;
  const markTraced = (key: string) => {
    remember(traced, key, now, MAX_TRACED);
    for (const [oldKey, at] of traced) {
      if (at >= now - 2 * STALE_UPDATE_MS) break;
      traced.delete(oldKey);
    }
  };

  const start = (
    name: string,
    parent: Tracer.AnySpan | undefined,
    startTime: bigint,
    attributes: Record<string, unknown>,
  ) => {
    const span = tracer.span({
      name,
      parent: parent === undefined ? Option.none() : Option.some(parent),
      annotations: Context.empty(),
      links: [],
      startTime,
      kind: "internal",
      root: parent === undefined,
      sampled: true,
    });
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.attribute(key, value);
    }
    return span;
  };

  const complete = (
    name: string,
    runId: string | null | undefined,
    startedAt: DateTime.Utc,
    completedAt: DateTime.Utc,
    failed: boolean,
    attributes: Record<string, unknown>,
    origin?: Tracer.AnySpan,
  ) => {
    const run = runId == null ? undefined : (runs.get(runId) ?? finished.get(runId));
    const span = start(name, run?.span ?? origin, nanos(startedAt), {
      ...run?.attributes,
      ...attributes,
    });
    span.end(nanos(completedAt), failed ? Exit.fail(name) : Exit.void);
  };

  const endRun = (id: string, open: OpenRun, status: string, endTime: bigint) => {
    runs.delete(id);
    remember(finished, id, open);
    open.span.attribute("t3.run.status", status);
    open.span.end(endTime, FAILED.has(status) ? Exit.fail(status) : Exit.void);
  };

  const onRun = (run: OrchestrationV2Run, occurredAt: DateTime.Utc) => {
    const open = runs.get(run.id);
    const stale = run.completedAt !== null && isStale(run.completedAt, occurredAt);
    if (open === undefined && run.startedAt !== null && !stale && !traced.has(`run:${run.id}`)) {
      markTraced(`run:${run.id}`);
      const model = run.modelSelection.model;
      const driver = drivers.get(run.providerInstanceId);
      const parentId = spawnParents.get(run.id);
      spawnParents.delete(run.id);
      const shared = {
        ...(privateMetadata && {
          "fork.run.ref": hashTelemetryId(run.id),
          "fork.thread.ref": hashTelemetryId(run.threadId),
          "fork.provider.driver": driver,
          ...(parentId && { "fork.parent.run_ref": hashTelemetryId(parentId) }),
        }),
        "gen_ai.provider.name": providerName(driver ?? run.providerInstanceId),
        "gen_ai.request.model": model,
        ...conversationAttributes(run.threadId),
        "t3.run.id": run.id,
      };
      const span = start(
        `invoke_agent ${run.providerInstanceId}`,
        origins.get(run.userMessageId),
        nanos(run.startedAt),
        {
          ...shared,
          "sentry.op": "gen_ai.invoke_agent",
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": run.providerInstanceId,
          "t3.delegated_task.id": run.delegatedTaskId ?? undefined,
        },
      );
      if (privateMetadata && parentId) {
        const parent = runs.get(parentId) ?? finished.get(parentId);
        if (parent)
          span.addLinks([{ span: parent.span, attributes: { "fork.link": "subagent_spawn" } }]);
      }
      origins.delete(run.userMessageId);
      runs.set(run.id, { span, model, attributes: shared });
      if (runs.size > MAX_OPEN_RUNS) {
        const [oldestId, oldest] = runs.entries().next().value!;
        endRun(oldestId, oldest, "untracked", nanos(occurredAt));
      }
    }
    const current = runs.get(run.id);
    if (current !== undefined && TERMINAL_RUN.has(run.status)) {
      endRun(run.id, current, run.status, nanos(run.completedAt ?? occurredAt));
    }
  };

  const onProviderTurn = (
    turn: OrchestrationV2ProviderTurn,
    runId: string | null | undefined,
    occurredAt: DateTime.Utc,
  ) => {
    const usage = turn.turnTokenUsage;
    const context = turn.tokenUsage;
    if (!TERMINAL_ITEM.has(turn.status) || turn.startedAt === null || turn.completedAt === null) {
      return;
    }
    if (traced.has(`turn:${turn.id}`) || isStale(turn.completedAt, occurredAt)) return;
    markTraced(`turn:${turn.id}`);
    complete(
      `chat ${turn.model ?? (runId == null ? undefined : (runs.get(runId) ?? finished.get(runId))?.model) ?? "model"}`,
      runId,
      turn.startedAt,
      turn.completedAt,
      turn.status === "failed",
      {
        "sentry.op": "gen_ai.chat",
        "gen_ai.operation.name": "chat",
        "gen_ai.response.model": turn.model ?? undefined,
        "gen_ai.usage.input_tokens": usage?.inputTokens,
        "gen_ai.usage.input_tokens.cached": usage?.cachedInputTokens,
        "gen_ai.usage.output_tokens": usage?.outputTokens,
        "gen_ai.usage.output_tokens.reasoning": usage?.reasoningTokens,
        "gen_ai.usage.input_tokens.cache_write": usage?.cacheCreationTokens,
        "gen_ai.context.window_size": context?.maxTokens ?? undefined,
        "gen_ai.context.utilization": context?.maxTokens
          ? context.usedTokens / context.maxTokens
          : undefined,
      },
    );
  };

  const onTurnItem = (item: OrchestrationV2TurnItem, occurredAt: DateTime.Utc) => {
    if (!TERMINAL_ITEM.has(item.status) || item.startedAt === null || item.completedAt === null) {
      return;
    }
    if (traced.has(`item:${item.id}`) || isStale(item.completedAt, occurredAt)) return;
    if (item.type === "assistant_message") {
      const run = item.runId === null ? undefined : runs.get(item.runId);
      if (
        privateMetadata &&
        run &&
        item.status === "completed" &&
        !item.streaming &&
        item.delivery !== "async" &&
        (item.phase === undefined || item.phase === "final_answer") &&
        item.text.trim()
      ) {
        run.span.attribute("fork.run.final_answer_observed", true);
      }
      return;
    }
    const failed = item.status === "failed";
    if (item.type === "compaction") {
      markTraced(`item:${item.id}`);
      complete("fork.compaction", item.runId, item.startedAt, item.completedAt, failed, {
        "fork.compaction.before_tokens": item.beforeTokenCount ?? undefined,
        "fork.compaction.after_tokens": item.afterTokenCount ?? undefined,
      });
      return;
    }
    if (item.type === "handoff") {
      markTraced(`item:${item.id}`);
      complete("fork.provider_handoff", item.runId, item.startedAt, item.completedAt, failed, {
        "fork.handoff.strategy": item.strategy,
        "fork.handoff.to_model": clip(item.toModel),
      });
      return;
    }
    const name = toolName(item);
    if (name === undefined) return;
    markTraced(`item:${item.id}`);
    complete(`execute_tool ${name}`, item.runId, item.startedAt, item.completedAt, failed, {
      "sentry.op": "gen_ai.execute_tool",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": name,
      "t3.subagent.thread.id":
        item.type === "subagent" ? (item.childThreadId ?? undefined) : undefined,
    });
  };

  // Resolution commits the answer before the adapter or a subsequent turn receives it.
  const onRuntimeRequest = (
    event: Extract<OrchestrationV2DomainEvent, { type: "runtime-request.updated" }>,
  ) => {
    const { payload: request, runId, occurredAt } = event;
    const metadata = privateMetadata
      ? {
          "fork.decision.ref": hashTelemetryId(request.id),
          "fork.thread.ref": hashTelemetryId(event.threadId),
          ...(runId && { "fork.run.ref": hashTelemetryId(runId) }),
          "fork.decision.response_mode": request.responseCapability.type,
          "sentry.op": "fork.decision",
        }
      : undefined;
    if (request.status === "pending") {
      const key = `pending:${request.id}`;
      if (metadata && !traced.has(key) && !isStale(request.createdAt, occurredAt)) {
        markTraced(key);
        complete("fork.decision.requested", runId, request.createdAt, request.createdAt, false, {
          ...metadata,
          "sentry.op": "fork.decision.requested",
          "fork.decision.kind": request.kind,
        });
      }
      return;
    }
    if (request.resolvedAt === null) return;
    if (traced.has(`request:${request.id}`) || isStale(request.resolvedAt, occurredAt)) return;
    markTraced(`request:${request.id}`);
    complete("fork.decision", runId, request.createdAt, request.resolvedAt, false, {
      ...metadata,
      "fork.decision.kind": request.kind,
      "fork.decision.status": request.status,
      "fork.decision.decision": request.decision,
    });
  };

  const onEvent = ({ event }: OrchestrationV2StoredEvent) => {
    now = Math.max(now, DateTime.toEpochMillis(event.occurredAt));
    switch (event.type) {
      case "context-transfer.created": {
        const transfer = event.payload;
        if (
          privateMetadata &&
          transfer.type === "subagent_spawn" &&
          transfer.targetRunId &&
          transfer.sourcePoint.runId
        )
          remember(spawnParents, transfer.targetRunId, transfer.sourcePoint.runId);
        return;
      }
      case "provider-thread.updated":
        if (privateMetadata)
          remember(drivers, event.payload.providerInstanceId, event.payload.driver);
        return;
      case "message.updated":
        return;
      case "provider-turn.updated":
        return onProviderTurn(event.payload, event.runId, event.occurredAt);
      case "turn-item.updated":
        return onTurnItem(event.payload, event.occurredAt);
      case "runtime-request.updated":
        return onRuntimeRequest(event);
      default:
        if (event.type.startsWith("run.") && "modelSelection" in event.payload) {
          return onRun(event.payload as OrchestrationV2Run, event.occurredAt);
        }
    }
  };

  const captureMessage = (
    message: OrchestrationV2ConversationMessage,
    consent: OrchestrationV2AppThread["sentryTextConsent"],
  ) => {
    if (
      consent?.threadId !== message.threadId ||
      message.runId === null ||
      !(DateTime.toEpochMillis(message.createdAt) > Date.parse(consent.since)) ||
      message.streaming ||
      !message.text ||
      message.notification ||
      message.threadId === `fork:dream:${message.id}` ||
      message.scheduledTaskId ||
      message.senderThreadId ||
      message.linkedSender ||
      message.workflowScript ||
      message.idleCompaction ||
      message.delegatedCompletion ||
      traced.has(`message:${message.id}`)
    )
      return;
    const user =
      message.role === "user" &&
      message.createdBy === "user" &&
      (message.creationSource === "web" || message.creationSource === "mobile");
    const assistant =
      message.role === "assistant" &&
      message.createdBy === "agent" &&
      message.creationSource === "provider";
    if (!user && !assistant) return;
    markTraced(`message:${message.id}`);
    complete(
      `fork.message ${message.role}`,
      message.runId,
      message.createdAt,
      message.updatedAt,
      false,
      {
        ...conversationAttributes(message.threadId),
        "t3.run.id": message.runId,
        "sentry.op": "gen_ai.message",
        [user ? "gen_ai.input.messages" : "gen_ai.output.messages"]: JSON.stringify([
          { role: message.role, content: message.text },
        ]),
      },
      user ? origins.get(message.id) : undefined,
    );
  };
  const dreamResult = (
    run: OrchestrationV2Run,
    items: readonly OrchestrationV2TurnItem[],
    plans: readonly OrchestrationV2PlanArtifact[],
  ) => {
    const key = `dream-result:${run.id}`;
    if (traced.has(key) || run.completedAt === null) return;
    markTraced(key);
    const time = nanos(run.completedAt);
    const span = start(
      "fork.dream.result",
      (runs.get(run.id) ?? finished.get(run.id))?.span,
      time,
      {
        "sentry.op": "fork.dream.result",
        "fork.dream.thread_ref": hashTelemetryId(run.threadId),
        "fork.dream.run_ref": hashTelemetryId(run.id),
        "fork.dream.status": run.status,
        "fork.dream.assistant_output": items.some(
          (item) =>
            item.type === "assistant_message" && !item.streaming && item.text.trim().length > 0,
        ),
        "fork.dream.proposed_plan": plans.some(
          (plan) =>
            plan.runId === run.id && plan.kind === "proposed_plan" && plan.status !== "draft",
        ),
      },
    );
    span.end(time, run.status === "failed" ? Exit.fail("failed") : Exit.void);
  };
  const needsDreamResult = (run: OrchestrationV2Run) =>
    privateMetadata && !traced.has(`dream-result:${run.id}`);
  return { onEvent, captureMessage, dreamResult, needsDreamResult };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (config.forkSentry === undefined) return;
    startRecordingOrigins();
    const sink = yield* EventSink.EventSinkV2;
    const recordingSince = yield* DateTime.now;
    let last = yield* (yield* EventStore.EventStoreV2).latestSequence();
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity.use(
      (service) => service.getEnvironmentId,
    ).pipe(Effect.provide(ServerEnvironment.layerIdentity));
    const tracing = yield* make(identity);
    const onStored = (stored: OrchestrationV2StoredEvent) =>
      Effect.suspend(() => {
        last = stored.sequence;
        try {
          tracing.onEvent(stored);
          const event = stored.event;
          if (
            config.forkSentry?.sampleTraces &&
            (event.type === "run.updated" || event.type === "run.created") &&
            event.threadId === `fork:dream:${event.payload.userMessageId}` &&
            tracing.needsDreamResult(event.payload) &&
            TERMINAL_RUN.has(event.payload.status) &&
            event.payload.completedAt !== null &&
            !isStale(event.payload.completedAt, event.occurredAt)
          ) {
            const run = event.payload;
            return projection
              .getThreadRecords(run.threadId, ["turnItems", "plans"], {
                turnItemRunId: run.id,
                turnItemTypes: ["assistant_message"],
                turnItemStatuses: ["completed"],
              })
              .pipe(
                Effect.map(({ turnItems, plans }) => tracing.dreamResult(run, turnItems, plans)),
                Effect.ignore,
              );
          }
          if (
            config.forkSentry?.sampleTraces &&
            event.type === "message.updated" &&
            DateTime.isGreaterThan(event.payload.createdAt, recordingSince) &&
            !event.payload.streaming &&
            !isStale(event.payload.updatedAt, event.occurredAt)
          ) {
            const message = event.payload;
            return projection.findThread(message.threadId).pipe(
              Effect.map((thread) => tracing.captureMessage(message, thread?.sentryTextConsent)),
              Effect.ignore,
            );
          }
          return Effect.void;
        } catch (defect) {
          return Effect.logWarning("Fork agent tracing skipped an event", {
            type: stored.event.type,
            defect: String(defect),
          });
        }
      });
    // Tracing must never stop orchestration; after a failure it resubscribes where it left off.
    yield* Stream.suspend(() => sink.stream({ afterSequence: last })).pipe(
      Stream.runForEach(onStored),
      Effect.tapCause((cause) => Effect.logWarning("Fork agent tracing stream failed", cause)),
      Effect.retry(Schedule.spaced("5 seconds")),
      Effect.forkScoped,
    );
  }),
);
