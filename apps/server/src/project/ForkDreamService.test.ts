import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Coordinator from "./ForkCoordinatorService.ts";
import * as Store from "./ForkCoordinatorStore.ts";
import * as Memory from "./ForkMemoryService.ts";
import * as Dream from "./ForkDreamService.ts";

it.effect(
  "resumes the same retained Dream snapshot after failure and reuses active or unchanged reviews",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("dream-project");
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'Dream', '/workspace/dream', '[]', '1970-01-01', '1970-01-01')`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES ('worker-source', ${projectId}, 'Worker', 'codex', 'full-access', 'default', '1970-01-01', '1970-01-01', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('source-run', 'worker-source', 1, 'codex', 'completed', '1970-01-01', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json) VALUES ('source-message', 'worker-source', 'source-run', 'assistant', 0, '1970-01-01', '1970-01-01', ${JSON.stringify({ text: "Verified: retain the retry key across reconnects." })})`;
      const store = yield* Store.ForkCoordinatorStore;
      const claimed = yield* store.claim({
        projectId,
        global: false,
        modelSelection,
        runtimeMode: "full-access",
      });
      const requests: Array<Launch.ThreadLaunchInput> = [];
      let fail = true;
      const selectedModel = { instanceId: ProviderInstanceId.make("devReplay"), model: "question" };
      let currentModel = selectedModel;
      const services = Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({ ...liveThreadShell(claimed.threadId), modelSelection: currentModel }),
        }),
        Layer.succeed(Store.ForkCoordinatorStore, store),
        Layer.succeed(SqlClient.SqlClient, sql),
        Layer.succeed(Memory.ForkMemoryService, yield* Memory.ForkMemoryService),
        Layer.mock(Coordinator.ForkCoordinatorService)({
          open: () => Effect.succeed({ projectId, global: false, threadId: claimed.threadId }),
        }),
        Layer.mock(Launch.ThreadLaunchService)({
          launch: (input) =>
            Effect.gen(function* () {
              requests.push(input);
              if (fail)
                return yield* new Launch.ThreadLaunchError({
                  commandId: input.commandId,
                  projectId,
                  operation: "create-thread",
                  cause: "simulated lost launch",
                });
              const threadId = input.threadId ?? ThreadId.make("missing");
              yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${threadId}, ${projectId}, 'Dream', 'codex', 'approval-required', 'plan', '1970-01-01', '1970-01-01', '{}')`.pipe(
                Effect.orDie,
              );
              yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES (${input.commandId}, ${threadId}, 1, 'codex', 'running', '1970-01-01', '{}')`.pipe(
                Effect.orDie,
              );
              return {
                threadId,
                projection: idleThreadProjection(liveThreadShell(threadId)),
                resumed: false,
              };
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const dreams = yield* Dream.ForkDreamService;
        const input = { projectId, commandId: CommandId.make("first-dream") };
        yield* dreams.start(input).pipe(Effect.flip);
        const firstRequest = requests[0];
        assert.include(firstRequest?.initialMessage?.text ?? "", "source-message");
        assert.deepStrictEqual(firstRequest?.modelSelection, selectedModel);
        assert.isNotTrue(firstRequest?.reuseExistingThread);
        assert.strictEqual(firstRequest?.runtimeMode, "approval-required");
        assert.strictEqual(firstRequest?.interactionMode, "plan");
        // The retry must use the retained evidence even after its original message was removed.
        yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'source-message'`;
        fail = false;
        currentModel = { ...selectedModel, model: "plan-and-reads" };
        const resumed = yield* dreams.start({ ...input, commandId: CommandId.make("retry-dream") });
        assert.isTrue(resumed.reused);
        assert.strictEqual(resumed.sourceCount, 1);
        assert.deepStrictEqual(requests[1], { ...firstRequest, modelSelection: currentModel });
        const active = yield* dreams.start({
          ...input,
          commandId: CommandId.make("while-running"),
        });
        assert.strictEqual(active.threadId, resumed.threadId);
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE thread_id = ${resumed.threadId}`;
        yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json) VALUES ('source-message', 'worker-source', 'source-run', 'assistant', 0, '1970-01-01', '1970-01-01', ${JSON.stringify({ text: "Verified: retain the retry key across reconnects." })})`;
        const unchanged = yield* dreams.start({
          ...input,
          commandId: CommandId.make("no-new-evidence"),
        });
        assert.isTrue(unchanged.reused);
        assert.strictEqual(unchanged.threadId, resumed.threadId);
        yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = ${JSON.stringify({ text: "New evidence: reconnect must retain the request body too." })} WHERE message_id = 'source-message'`;
        const next = yield* dreams.start({ ...input, commandId: CommandId.make("new-evidence") });
        assert.isFalse(next.reused);
        assert.notEqual(next.threadId, resumed.threadId);
        assert.include(requests.at(-1)?.initialMessage?.text ?? "", "request body");
      }).pipe(Effect.provide(Dream.layer.pipe(Layer.provide(services))));
    }).pipe(
      Effect.provide(
        Layer.merge(Store.layer, Memory.layer).pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    ),
);
