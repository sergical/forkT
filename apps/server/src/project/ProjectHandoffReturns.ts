import {
  CommandId,
  EventId,
  type OrchestrationV2Notification,
  type MessageId,
  forkCoordinatorProjectId,
  forkProjectReturnMessageId,
  type EnvironmentId,
  type RunId,
  type ProviderThreadId,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import {
  SUBAGENT_RESULT_TURN_ITEM_TYPES,
  subagentResultForRun,
} from "@t3tools/provider-core/server/subagentProjection";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  delegatedTaskAwaitsWork,
  delegatedTaskResultRun,
  runOutcome,
} from "../orchestration-v2/RestartBackgroundNote.ts";
import {
  ThreadManagementService,
  type ThreadManagementProviderInstanceDisabledError,
  isTerminalRunStatus,
} from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";

interface Handoff {
  readonly run_id: RunId;
  readonly source_thread_id: ThreadId;
  readonly project_thread_id: ThreadId;
  readonly environment_id: EnvironmentId;
}

const resultFor = Effect.fn("ProjectHandoffReturns.resultFor")(function* (handoff: Handoff) {
  const engine = yield* OrchestratorV2;
  const threadId = handoff.project_thread_id;
  const sql = yield* SqlClient.SqlClient;
  const candidates = yield* sql<{ run_id: RunId; provider_thread_id: ProviderThreadId | null }>`
    SELECT run_id, provider_thread_id FROM orchestration_v2_projection_runs
    WHERE thread_id = ${threadId} AND ordinal >=
      (SELECT ordinal FROM orchestration_v2_projection_runs WHERE run_id = ${handoff.run_id})
  `;
  const candidateIds = candidates.map((r) => r.run_id);
  const projection = yield* engine.getThreadRecords(
    threadId,
    ["runs", "messages", "subagents", "providerThreads"],
    {
      delegatedTaskMessagesOnly: true,
      runIds: candidateIds,
      messageRunIds: candidateIds,
      subagentRunIds: candidateIds,
      providerThreadIds: candidates.flatMap((r) => r.provider_thread_id ?? []),
    },
  );
  const owned = new Set([handoff.run_id]);
  const wakeParents = new Map(
    projection.messages.map((m) => [m.id, m.delegatedCompletion?.parentRunId]),
  );
  // A persistent coordinator can already be working on another handoff. Only follow this one's
  // restart and delegate wakes, whose parent always precedes them in run ordinal order.
  for (const run of projection.runs) {
    const parent =
      run.restartContinuationOfRunId ??
      run.usageLimitContinuationOfRunId ??
      run.manualContinuationOfRunId ??
      wakeParents.get(run.userMessageId);
    if (parent !== undefined && owned.has(parent)) owned.add(run.id);
  }
  const runs = projection.runs.filter((run) => owned.has(run.id));
  const run = delegatedTaskResultRun(runs);
  if (run === undefined) return;
  const runIds = [...owned];
  const requests = yield* engine.getThreadRecords(threadId, ["runtimeRequests"], {
    runtimeRequestStatuses: ["pending"],
  });
  const blockingIds = requests.runtimeRequests.flatMap((r) =>
    r.responseCapability.type === "live" ? [r.id] : [],
  );
  if (blockingIds.length > 0) {
    const { turnItems } = yield* engine.getThreadRecords(threadId, ["turnItems"], {
      turnItemRunIds: runIds,
      turnItemRequestIds: blockingIds,
      turnItemTypes: ["approval_request", "user_input_request"],
    });
    const item = turnItems.at(-1);
    if (item?.type === "user_input_request" || item?.type === "approval_request") {
      const detail =
        item.type === "user_input_request"
          ? item.questions.map((q) => q.question).join("\n")
          : (item.prompt ?? item.reason ?? item.title);
      return { summary: "Project needs your input", outcome: "updated" as const, detail };
    }
  }
  if (!isTerminalRunStatus(run.status) || (yield* engine.restartContinuationPending(run))) return;
  if (delegatedTaskAwaitsWork(runs, projection)) return;
  const report = yield* engine.getThreadRecords(
    threadId,
    ["messages", "turnItems", "providerTurns"],
    {
      messageRoles: ["assistant"],
      messageRunIds: [run.id],
      turnItemRunIds: [run.id],
      turnItemTypes: [...SUBAGENT_RESULT_TURN_ITEM_TYPES],
      providerTurnAttemptIds: run.activeAttemptId === null ? [] : [run.activeAttemptId],
    },
  );
  const result = subagentResultForRun(report, run);
  const status = runOutcome(run);
  if (status === "completed" && result.messageId === null && result.turnItemId === null) {
    return {
      summary: "Project finished without a report",
      outcome: "failed" as const,
      detail: result.text,
    };
  }
  return {
    summary: `Project handoff ${status.replace("_", " ")}`,
    outcome: status === "completed" || status === "failed" ? status : ("cancelled" as const),
    detail: result.text,
  };
});

// A disabled project instance refuses dispatch before its message exists. Commit the same
// receipt and input as a failed run, without creating a provider session or a start effect.
const recordDisabledReturn = Effect.fn("ProjectHandoffReturns.recordDisabledReturn")(function* (
  command: {
    commandId: CommandId;
    threadId: ThreadId;
    messageId: MessageId;
    senderThreadId: ThreadId;
    text: string;
    notification: OrchestrationV2Notification;
  },
  cause: ThreadManagementProviderInstanceDisabledError,
) {
  const { threadId, commandId, messageId, notification } = command;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  return yield* executor.withLock(
    threadId,
    Effect.gen(function* () {
      const thread = yield* (yield* OrchestratorV2).getThreadShell(threadId);
      if (
        !thread ||
        thread.deletedAt ||
        thread.archivedAt ||
        thread.modelSelection.instanceId !== cause.instanceId
      )
        return false;
      const sql = yield* SqlClient.SqlClient;
      const [next] = yield* sql<{ ordinal: number }>`SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
      FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}`;
      const ordinal = next!.ordinal;
      const runId = derive.run({ threadId, ordinal });
      const now = yield* DateTime.now;
      const event = { threadId, runId, occurredAt: now, providerInstanceId: cause.instanceId };
      const item = {
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      const { receipt } = yield* (yield* EventSink.EventSinkV2).commitCommand({
        threadId,
        commandId,
        commandType: "message.dispatch",
        acceptedAt: now,
        effects: [],
        events: [
          {
            ...event,
            id: EventId.make(`${commandId}:run`),
            type: "run.created",
            payload: {
              id: runId,
              threadId,
              ordinal,
              providerInstanceId: cause.instanceId,
              modelSelection: thread.modelSelection,
              userMessageId: messageId,
              providerThreadId: null,
              rootNodeId: null,
              activeAttemptId: null,
              status: "failed",
              requestedAt: now,
              startedAt: null,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          {
            ...event,
            id: EventId.make(`${commandId}:message`),
            type: "message.updated",
            payload: {
              threadId,
              runId,
              id: messageId,
              nodeId: null,
              role: "user",
              createdBy: "agent",
              creationSource: "server",
              senderThreadId: command.senderThreadId,
              text: command.text,
              notification,
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            ...event,
            id: EventId.make(`${commandId}:notice`),
            type: "turn-item.updated",
            payload: {
              ...item,
              id: derive.userTurnItem({ messageId }),
              type: "notification",
              ordinal: 1,
              status: "completed",
              title: notification.summary,
              ...notification,
            },
          },
          {
            ...event,
            id: EventId.make(`${commandId}:error`),
            type: "turn-item.updated",
            payload: {
              ...item,
              id: derive.runSignalTurnItem({ runId, signal: "project-provider-disabled" }),
              type: "error",
              ordinal: 2,
              status: "failed",
              title: "Provider disabled for this project",
              failure: makeProviderFailure({
                class: "provider_error",
                code: "project_provider_disabled",
                retryable: true,
                message: `${cause.message} Enable this provider or choose an enabled provider, then retry.`,
              }),
            },
          },
        ],
      });
      return receipt.status === "accepted" && receipt.threadId === threadId;
    }),
  );
});

const deliver = Effect.fn("ProjectHandoffReturns.deliver")(function* (row: Handoff) {
  const sql = yield* SqlClient.SqlClient;
  const markDelivered = sql`UPDATE fork_project_handoff_returns SET delivered = 1 WHERE run_id = ${row.run_id}`;
  const commandId = CommandId.make(`project-handoff-return:${row.run_id}`);
  const receipt = yield* (yield* CommandReceipts.CommandReceiptStoreV2).getByCommandId(commandId);
  if (
    Option.isSome(receipt) &&
    receipt.value.status === "accepted" &&
    receipt.value.threadId === row.source_thread_id
  ) {
    yield* markDelivered;
    return;
  }
  const threads = yield* ThreadManagementService;
  const source = yield* threads.getThreadShell(row.source_thread_id);
  if (source === null || source.deletedAt !== null || source.archivedAt !== null) return;
  const result = yield* sql.withTransaction(resultFor(row)).pipe(NodeSqliteClient.readOnly);
  if (result === undefined) return;
  const link = formatThreadLink(
    { environmentId: row.environment_id, threadId: row.project_thread_id },
    "Project coordinator",
  );
  const command = {
    type: "message.dispatch",
    commandId,
    threadId: row.source_thread_id,
    messageId: forkProjectReturnMessageId(row.run_id),
    text: `${result.summary} from ${link}.\n\n${result.detail}`,
    notification: { source: { kind: "system" }, outcome: result.outcome, summary: result.summary },
    senderThreadId: row.project_thread_id,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  } as const;
  const saved = yield* threads.dispatch(command).pipe(
    Effect.as(true),
    Effect.catchTags({
      ThreadManagementProviderInstanceDisabledError: (cause) =>
        recordDisabledReturn(command, cause),
    }),
  );
  if (saved) yield* markDelivered;
});

export const reconcile = Effect.fn("ProjectHandoffReturns.reconcile")(function* (
  threadId?: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const pending = yield* sql<Handoff>`SELECT * FROM fork_project_handoff_returns WHERE delivered = 0
    ${threadId === undefined ? sql`` : sql`AND project_thread_id = ${threadId}`}`;
  for (const row of pending) {
    yield* deliver(row).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not deliver project handoff", { runId: row.run_id, cause }),
      ),
    );
  }
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestratorV2;
    const changed = engine.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          forkCoordinatorProjectId(event.threadId) !== null &&
          ((event.type === "run.updated" && isTerminalRunStatus(event.payload.status)) ||
            event.type === "subagent.updated" ||
            (event.type === "runtime-request.updated" && event.payload.status === "pending") ||
            event.type === "provider-thread.updated"),
      ),
      Stream.map((event) => event.threadId),
    );
    // Live events handle the normal path. The sweep recovers missed events and failed deliveries.
    const recover = Stream.make(undefined).pipe(Stream.repeat(Schedule.spaced("1 minute")));
    yield* forkParked(
      Stream.merge(changed, recover).pipe(
        Stream.runForEach((id) =>
          reconcile(id).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not read pending handoffs", { cause }),
            ),
          ),
        ),
      ),
    );
  }),
).pipe(Layer.provide(Layer.merge(CommandReceipts.layer, ThreadCommandExecutor.layer)));
