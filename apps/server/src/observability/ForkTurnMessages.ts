import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

type TurnEvent = Extract<OrchestrationV2DomainEvent, { type: "provider-turn.updated" }>;

export const make = Effect.fnUntraced(function* (recordingSince: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  const since = DateTime.formatIso(recordingSince);
  // Read the consent and visible text in one snapshot, just before ending the provider span.
  return Effect.fnUntraced(function* ({ threadId, payload: turn, runId }: TurnEvent) {
    return yield* sql<{
      id: string;
      role: "user" | "assistant";
      content: string;
      ordinal: number;
      phase: "commentary" | "partial_answer" | "final_answer" | null;
      since: string;
    }>`
      SELECT m.message_id AS id, m.role, json_extract(m.payload_json, '$.text') AS content,
        i.ordinal, json_extract(i.payload_json, '$.phase') AS phase,
        max(${since}, json_extract(t.payload_json, '$.sentryTextConsent.since')) AS since
      FROM orchestration_v2_projection_threads AS t
      CROSS JOIN orchestration_v2_projection_turn_items AS i ON (
        i.provider_turn_id = ${turn.id} OR (
          i.type = 'user_message' AND i.provider_turn_id IS NULL
          AND i.node_id = ${turn.nodeId} AND i.run_id = ${runId ?? null}
          AND ${turn.id} = (
            SELECT provider_turn_id FROM orchestration_v2_projection_provider_turns
            WHERE run_attempt_id = ${turn.runAttemptId} ORDER BY ordinal LIMIT 1
          )
        )
      )
      CROSS JOIN orchestration_v2_projection_messages AS m
        ON m.message_id = json_extract(i.payload_json, '$.messageId')
      WHERE t.thread_id = ${threadId}
        AND json_extract(t.payload_json, '$.sentryTextConsent.threadId') = t.thread_id
        AND m.thread_id = t.thread_id AND m.run_id IS i.run_id
        AND m.created_at > max(${since}, json_extract(t.payload_json, '$.sentryTextConsent.since'))
        AND m.streaming = 0 AND length(json_extract(m.payload_json, '$.text')) > 0
        AND (
          (i.type = 'assistant_message' AND m.role = 'assistant'
            AND json_extract(m.payload_json, '$.createdBy') = 'agent'
            AND json_extract(m.payload_json, '$.creationSource') = 'provider')
          OR (i.type = 'user_message' AND i.status = 'completed' AND m.role = 'user'
            AND json_extract(m.payload_json, '$.createdBy') = 'user'
            AND json_extract(m.payload_json, '$.creationSource') IN ('web', 'mobile'))
        )
        AND json_extract(m.payload_json, '$.notification') IS NULL
        AND json_extract(m.payload_json, '$.scheduledTaskId') IS NULL
        AND json_extract(m.payload_json, '$.senderThreadId') IS NULL
        AND json_extract(m.payload_json, '$.linkedSender') IS NULL
        AND NOT coalesce(json_extract(m.payload_json, '$.workflowScript'), 0)
        AND json_extract(m.payload_json, '$.idleCompaction') IS NULL
        AND json_extract(m.payload_json, '$.delegatedCompletion') IS NULL
        AND t.thread_id != ('fork:dream:' || m.message_id)
      ORDER BY i.ordinal, i.turn_item_id
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.orElseSucceed(() => []),
    );
  });
});
