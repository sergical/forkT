import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Store from "./ForkCoordinatorStore.ts";

it.effect(
  "keeps one coordinator per scope through concurrent claims and replaces only deleted threads",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* Store.ForkCoordinatorStore;
      const sql = yield* SqlClient.SqlClient;
      const input = {
        projectId: ProjectId.make("project-a"),
        global: false,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
        runtimeMode: "full-access" as const,
      };
      const [first, retry] = yield* Effect.all([store.claim(input), store.claim(input)], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(first, retry);
      assert.deepStrictEqual(yield* store.forThread(first.threadId), first);
      const recovered = yield* store.claim({
        ...input,
        modelSelection: { ...input.modelSelection, model: "replacement" },
      });
      assert.strictEqual(recovered.threadId, first.threadId);
      assert.strictEqual(recovered.modelSelection.model, "replacement");
      const other = yield* store.claim({ ...input, projectId: ProjectId.make("project-b") });
      assert.notEqual(first.threadId, other.threadId);
      const global = yield* store.claim({ ...input, global: true });
      assert.deepStrictEqual(
        yield* store.claim({ ...input, projectId: other.projectId, global: true }),
        global,
      );
      yield* sql`
    INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, deleted_at, payload_json)
    VALUES (${first.threadId}, ${input.projectId}, 'Coordinator', 'codex', 'full-access', 'default', '2026-11-17', '2026-11-17', '2026-11-17', '{}')
  `;
      const replacement = yield* store.claim(input);
      assert.strictEqual(replacement.generation, 2);
      assert.notEqual(replacement.threadId, first.threadId);
      assert.strictEqual(yield* store.forThread(first.threadId), null);
      assert.deepStrictEqual(yield* store.claim(input), replacement);
    }).pipe(
      Effect.provide(
        Store.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
      ),
    ),
);
