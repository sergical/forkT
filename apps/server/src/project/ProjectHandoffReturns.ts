import {
  CommandId,
  forkCoordinatorProjectId,
  MessageId,
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  delegatedTaskAwaitsWork,
  delegatedTaskResultRun,
  runOutcome,
} from "../orchestration-v2/RestartBackgroundNote.ts";
import {
  ThreadManagementService,
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
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId,
    threadId: row.source_thread_id,
    messageId: MessageId.make(`message:project-handoff-return:${row.run_id}`),
    text: `${result.summary} from ${link}.\n\n${result.detail}`,
    notification: { source: { kind: "system" }, outcome: result.outcome, summary: result.summary },
    senderThreadId: row.project_thread_id,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  });
  yield* markDelivered;
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
).pipe(Layer.provide(CommandReceipts.layer));
