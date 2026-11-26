import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MAIN_COORDINATOR_MEMORY_SCOPE,
  MessageId,
  ProjectId,
  ThreadId,
  RunId,
  type ForkMemorySaveInput,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ForkMemoryService from "./ForkMemoryService.ts";
import { MEMORY_BRIEF_MAX_BYTES } from "./forkMemoryBrief.ts";

const projectId = ProjectId.make("project-memory");
const otherProjectId = ProjectId.make("project-other");
const threadId = ThreadId.make("thread-memory");
const messageId = MessageId.make("message-memory");
const input: ForkMemorySaveInput = {
  projectId,
  id: "retry-rule",
  commandId: CommandId.make("remember-retry"),
  expectedRevision: 0,
  kind: "decision",
  title: "Retry only idempotent requests",
  body: "A failed payment request must not be retried without its idempotency key.",
  reason: "Preserve the decision behind payment recovery.",
  sources: [{ threadId, messageId }],
};

const setup = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  for (const id of [projectId, otherProjectId]) {
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${id}, 'Test', ${`/workspace/${id}`}, '[]', '2026-11-17', '2026-11-17')
    `;
  }
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json
    ) VALUES (${threadId}, ${projectId}, 'Payments', 'codex', 'full-access', 'default', '2026-11-17', '2026-11-17', '{}')
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_messages (
      message_id, thread_id, role, streaming, created_at, updated_at, payload_json
    ) VALUES (${messageId}, ${threadId}, 'user', 0, '2026-11-17', '2026-11-17', ${JSON.stringify({ text: "Keep the payment idempotency key on retries." })})
  `;
  return yield* ForkMemoryService.ForkMemoryService;
});

const memoryLayer = ForkMemoryService.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

it.effect("keeps sourced revisions and rejects stale edits without duplicating retries", () =>
  Effect.gen(function* () {
    const memory = yield* setup;
    const saved = yield* memory.save(input);
    assert.strictEqual(saved.revision, 1);
    assert.deepStrictEqual(yield* memory.save(input), saved);
    assert.strictEqual(
      (yield* memory
        .save({ ...input, body: "A different request with the same command ID." })
        .pipe(Effect.flip)).reason,
      "invalid",
    );
    assert.strictEqual((yield* memory.history(input)).length, 1);
    const edited = yield* memory.save({
      ...input,
      commandId: CommandId.make("edit-retry"),
      expectedRevision: 1,
      body: "Retain the idempotency key across every payment retry, including reconnects.",
    });
    assert.strictEqual(edited.revision, 2);
    assert.strictEqual(
      (yield* memory.save({ ...input, commandId: CommandId.make("stale-dream") }).pipe(Effect.flip))
        .reason,
      "conflict",
    );
    assert.deepStrictEqual(yield* memory.get(input), edited);
    assert.deepStrictEqual(
      (yield* memory.history(input)).map((entry) => entry.revision),
      [2, 1],
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = ${messageId}`;
    const corrected = yield* memory.save({
      ...input,
      commandId: CommandId.make("after-source-deletion"),
      expectedRevision: 2,
      body: "Corrected durable lesson.",
    });
    assert.strictEqual(corrected.revision, 3);
    assert.strictEqual(corrected.sources[0]?.text, "Keep the payment idempotency key on retries.");
  }).pipe(Effect.provide(memoryLayer)),
);

it.effect("scopes retrieval and rejects sources belonging to a different project", () =>
  Effect.gen(function* () {
    const memory = yield* setup;
    yield* memory.save(input);
    assert.strictEqual((yield* memory.search({ projectId, query: "idempotency" })).length, 1);
    assert.deepStrictEqual(
      yield* memory.search({ projectId: otherProjectId, query: "idempotency" }),
      [],
    );
    assert.deepStrictEqual(yield* memory.search({ projectId: null, query: "idempotency" }), []);
    assert.strictEqual(
      (yield* memory
        .save({ ...input, projectId: otherProjectId, commandId: CommandId.make("wrong-source") })
        .pipe(Effect.flip)).reason,
      "source_unavailable",
    );
    assert.deepStrictEqual(yield* memory.history({ ...input, projectId: otherProjectId }), []);
    yield* memory.save({
      ...input,
      projectId: null,
      commandId: CommandId.make("personal"),
      sources: [],
    });
    assert.strictEqual((yield* memory.search({ projectId: null, query: "idempotency" })).length, 1);
    assert.deepStrictEqual(yield* memory.search({ projectId, query: '" OR * ()' }), []);
    assert.strictEqual(
      (yield* memory.search({ projectId: ProjectId.make("absent"), query: "" }).pipe(Effect.flip))
        .reason,
      "not_found",
    );
  }).pipe(Effect.provide(memoryLayer)),
);

it.effect("lists and searches every live scope, personal first, keeping same titles apart", () =>
  Effect.gen(function* () {
    const memory = yield* setup;
    const sql = yield* SqlClient.SqlClient;
    const save = (scope: ProjectId | null, id: string, title: string) =>
      memory.save({
        ...input,
        projectId: scope,
        id,
        title,
        commandId: CommandId.make(`index-${scope ?? "personal"}-${id}`),
        sources: [],
      });
    yield* save(projectId, "hands", "How hands-on to be");
    yield* save(null, "hands", "How hands-on to be");
    yield* save(otherProjectId, "deleted", "Hands in a deleted project");
    yield* save(null, "forgotten", "Hands someone forgot");
    yield* memory.forget({ projectId: null, id: "forgotten", expectedRevision: 1 });
    yield* sql`UPDATE projection_projects SET deleted_at = '2026-11-18' WHERE project_id = ${otherProjectId}`;

    const keys = (entries: ReadonlyArray<{ projectId: ProjectId | null; id: string }>) =>
      entries.map((entry) => `${entry.projectId ?? "personal"}/${entry.id}`);
    const live = ["personal/hands", `${projectId}/hands`];
    assert.deepStrictEqual(keys(yield* memory.index({ query: "" })), live);
    assert.deepStrictEqual(keys(yield* memory.index({ query: "han" })), live);
    assert.deepStrictEqual(yield* memory.index({ query: "payments refunds" }), []);
  }).pipe(Effect.provide(memoryLayer)),
);

it.effect("forgets content and history and prevents an old capture from restoring it", () =>
  Effect.gen(function* () {
    const memory = yield* setup;
    yield* memory.save(input);
    assert.strictEqual(
      (yield* memory.forget({ ...input, expectedRevision: 2 }).pipe(Effect.flip)).reason,
      "conflict",
    );
    yield* memory.forget({ ...input, expectedRevision: 1 });
    yield* memory.forget({ ...input, expectedRevision: 1 });
    assert.strictEqual(yield* memory.get(input), null);
    assert.deepStrictEqual(yield* memory.search({ projectId, query: "idempotency" }), []);
    assert.deepStrictEqual(yield* memory.history(input), []);
    assert.strictEqual((yield* memory.save(input).pipe(Effect.flip)).reason, "forgotten");
    const sql = yield* SqlClient.SqlClient;
    assert.deepStrictEqual(yield* sql`SELECT payload_json FROM fork_memories`, [
      { payload_json: null },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT * FROM fork_memory_revisions`, []);
    assert.deepStrictEqual(yield* sql`SELECT * FROM fork_memory_search`, []);
  }).pipe(Effect.provide(memoryLayer)),
);

it.effect("reopens saved memory with its source and revision after closing the database", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-memory-" });
    const layer = ForkMemoryService.layer.pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: `${dir}/state.sqlite` })),
    );
    const decision = "Keep the ad hoc payment experiments offline.";
    const saved = yield* Effect.scoped(
      Effect.gen(function* () {
        const memory = yield* setup;
        yield* memory.save({
          ...input,
          projectId: MAIN_COORDINATOR_MEMORY_SCOPE,
          title: "Ad hoc payment experiments",
          commandId: CommandId.make("main-memory-reopen"),

          body: decision,
          sources: [],
        });
        return yield* memory.save(input);
      }).pipe(Effect.provide(layer)),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const memory = yield* ForkMemoryService.ForkMemoryService;
        assert.deepStrictEqual(yield* memory.get(input), saved);
        assert.strictEqual(yield* memory.get({ ...input, projectId: null }), null);
        const main = yield* memory.brief({
          projectId,
          runId: RunId.make("main-after-reopen"),
          query: "payment",
          mainCoordinator: true,
        });
        assert.include(main, decision);
        assert.notInclude(main, "idempotency key");
        const project = yield* memory.brief({
          projectId,
          runId: RunId.make("project-after-reopen"),
          query: "payment",
        });
        assert.include(project, "idempotency key");
        assert.notInclude(project, decision);
      }).pipe(Effect.provide(layer)),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("bounds memory context and keeps retry selection stable while honoring forgetting", () =>
  Effect.gen(function* () {
    const memory = yield* setup;
    const spans: Array<Tracer.Span> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    yield* memory.save(input);
    const request = { projectId, runId: RunId.make("memory-run"), query: "payment retries" };
    const first = yield* memory.brief(request).pipe(Effect.withTracer(tracer));
    assert.include(first, "idempotency key");
    yield* memory.save({
      ...input,
      expectedRevision: 1,
      commandId: CommandId.make("new-guidance"),
      body: "The decision has changed.",
    });
    assert.strictEqual(yield* memory.brief(request), first);
    assert.strictEqual(
      (yield* memory.brief({ ...request, projectId: otherProjectId }).pipe(Effect.flip)).reason,
      "invalid",
    );
    assert.strictEqual(
      yield* memory.brief({
        ...request,
        projectId: otherProjectId,
        runId: RunId.make("other-run"),
      }),
      "",
    );
    for (let index = 0; index < 8; index++) {
      yield* memory.save({
        ...input,
        id: `large-${index}`,
        commandId: CommandId.make(`large-${index}`),
        body: "payment 決定".repeat(400),
      });
    }
    const bounded = yield* memory.brief({ ...request, runId: RunId.make("large-run") });
    assert.isAbove(Buffer.byteLength(bounded, "utf8"), 0);
    assert.isAtMost(Buffer.byteLength(bounded, "utf8"), MEMORY_BRIEF_MAX_BYTES);
    yield* memory.forget({ ...input, expectedRevision: 2 });
    assert.strictEqual(yield* memory.brief(request).pipe(Effect.withTracer(tracer)), "");
    const briefs = spans.filter((span) => span.name === "fork.memory.brief");
    assert.deepStrictEqual(
      briefs.map((span) => span.attributes.get("fork.memory.selected_count")),
      [1, 0],
    );
    const attributes = JSON.stringify(briefs.map((span) => Object.fromEntries(span.attributes)));
    for (const privateValue of [request.query, request.runId, input.id, input.title, input.body]) {
      assert.notInclude(attributes, privateValue);
    }
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES (${request.runId}, ${threadId}, 1, 'codex', 'completed', '2026-11-17', '{}')`;
    yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${request.runId}`;
    assert.deepStrictEqual(
      yield* sql`SELECT run_id FROM fork_memory_briefs WHERE run_id = ${request.runId}`,
      [],
    );
  }).pipe(Effect.provide(memoryLayer)),
);
