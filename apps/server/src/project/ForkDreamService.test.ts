import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  RunId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  MessageId,
  EnvironmentId,
  type ForkDreamSubmitInput,
  WS_METHODS,
  WsRpcGroup,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import { McpSchema, McpServer } from "effect/ai";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as MemoryHandlers from "../mcp/toolkits/memory/handlers.ts";
import { MemoryToolkit } from "../mcp/toolkits/memory/tools.ts";
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

const projectId = ProjectId.make("dream-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
const seed = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'Dream', '/workspace/dream', '[]', '1970-01-01', '1970-01-01')`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES ('worker-source', ${projectId}, 'Worker', 'codex', 'full-access', 'default', '1970-01-01', '1970-01-01', '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('source-run', 'worker-source', 1, 'codex', 'completed', '1970-01-01', '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json) VALUES ('source-message', 'worker-source', 'source-run', 'assistant', 0, '1970-01-01', '1970-01-01', ${JSON.stringify({ text: "Verified: retain the retry key across reconnects." })})`;
});
const database = (filename: string) =>
  Layer.merge(Store.layer, Memory.layer).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename })),
  );
const testServices = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Store.ForkCoordinatorStore;
  const claimed = yield* store.claim({
    projectId,
    global: false,
    modelSelection,
    runtimeMode: "full-access",
  });
  const requests: Array<Launch.ThreadLaunchInput> = [];
  let fail = false;
  const selectedModel = { instanceId: ProviderInstanceId.make("devReplay"), model: "question" };
  let currentModel = selectedModel;
  const services = Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed({
          ...liveThreadShell(
            threadId,
            threadId.startsWith("fork:dream:")
              ? {
                  interactionMode: "plan",
                  runtimeMode: "approval-required",
                  activeRunId: RunId.make(threadId.slice("fork:dream:".length)),
                }
              : {},
          ),
          modelSelection: currentModel,
        }),
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

  return {
    services: Dream.layer.pipe(Layer.provideMerge(services)),
    claimed,
    requests,
    selectedModel,
    failLaunch: () => {
      fail = true;
    },
    finishRecovery: () => {
      fail = false;
      currentModel = { ...selectedModel, model: "plan-and-reads" };
    },
  };
});
it.effect(
  "resumes the same retained Dream snapshot after failure and reuses active or unchanged reviews",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const { services, requests, selectedModel, failLaunch, finishRecovery } = yield* testServices;
      failLaunch();
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
        finishRecovery();
        const currentModel = { ...selectedModel, model: "plan-and-reads" };
        const resumed = yield* dreams.start({ ...input, commandId: CommandId.make("retry-dream") });
        assert.isTrue(resumed.reused);
        assert.strictEqual(resumed.sourceCount, 1);
        assert.deepStrictEqual(requests[1], { ...firstRequest, modelSelection: currentModel });
        const active = yield* dreams.start({
          ...input,
          commandId: CommandId.make("while-running"),
        });
        assert.strictEqual(active.threadId, resumed.threadId);
        yield* dreams.submit(resumed.threadId, RunId.make(input.commandId), { suggestions: [] });
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
        yield* sql`UPDATE orchestration_v2_projection_runs SET status='completed' WHERE thread_id=${next.threadId}`;
        assert.strictEqual((yield* dreams.review(next.threadId))?.state, "incomplete");
        assert.deepEqual((yield* dreams.review(resumed.threadId))?.suggestions, []);
        assert.strictEqual((yield* dreams.review(resumed.threadId))?.state, "ready");
        assert.strictEqual(
          (yield* dreams.start({ ...input, commandId: CommandId.make("while-running") })).threadId,
          resumed.threadId,
        );
        assert.isFalse(
          (yield* dreams.start({ ...input, commandId: CommandId.make("retry-incomplete") })).reused,
        );
      }).pipe(Effect.provide(services));
    }).pipe(Effect.provide(database(":memory:"))),
);

const scopeFor = (threadId: ThreadId): Invocation.McpInvocationScope => ({
  environmentId: EnvironmentId.make("test-environment"),
  issuedAt: 0,
  requestNamespace: "dream-test",
  thread: { threadId, providerInstanceId: modelSelection.instanceId, providerSessionId: "session" },
  client: undefined,
  capabilities: new Set(["orchestration"]),
});

it.effect(
  "returns the plan-mode review to its callers once and preserves human decisions across restart",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "forkt-dream-" });
      const db = database(`${directory}/test.sqlite`);
      const caller = ThreadId.make("fork:global:1");
      const source = {
        threadId: ThreadId.make("worker-source"),
        messageId: MessageId.make("source-message"),
      };
      const key = { projectId, id: "retry-rule" };
      const before = {
        ...key,
        commandId: CommandId.make("before"),
        kind: "decision" as const,
        title: "Retry",
        body: "Keep the request key.",
        reason: "Project decision.",
        sources: [source],
        expectedRevision: 0,
      };
      const start = { projectId, commandId: CommandId.make("review-retained") };
      const threadId = ThreadId.make(`fork:dream:${start.commandId}`);
      const proposed = {
        memoryId: key.id,
        expectedRevision: 1,
        kind: before.kind,
        title: before.title,
        body: "Retain the retry key across reconnects.",
        reason: "Verified by the worker.",
        sources: [source],
      };
      const suggestions = [
        proposed,
        { ...proposed, memoryId: "retry-log", expectedRevision: 0, title: "Retry log" },
        { ...proposed, memoryId: "other", title: "Other rule" },
      ];
      const first = Effect.gen(function* () {
        yield* seed;
        const { services, claimed } = yield* testServices;
        return yield* Effect.gen(function* () {
          const memory = yield* Memory.ForkMemoryService;
          const dreams = yield* Dream.ForkDreamService;
          const sql = yield* SqlClient.SqlClient;
          yield* memory.save(before);
          yield* memory.save({ ...before, id: "other", commandId: CommandId.make("other-before") });
          const server = yield* McpServer.McpServer;
          const profile = {
            protocolVersion: "2025-06-18" as const,
            capabilities: {},
            clientInfo: { name: "codex", version: "test" },
          };
          const client = McpSchema.McpServerClient.of({
            ...profile,
            clientId: 1,
            clientCapabilities: {},
            initializePayload: profile,
            getClient: Effect.die("unused"),
          });
          const call = (id: ThreadId, name: string, input: Record<string, unknown>) =>
            server
              .callTool({ name, arguments: input })
              .pipe(
                Effect.provideService(Invocation.McpInvocationContext, scopeFor(id)),
                Effect.provideService(McpSchema.McpServerClient, client),
              );
          assert.deepInclude((yield* call(caller, "t3_dream_start", start)).structuredContent, {
            threadId,
          });
          assert.strictEqual(
            (yield* dreams.start({ ...start, commandId: CommandId.make("settings-request") }))
              .threadId,
            threadId,
          );
          const submit = (input: ForkDreamSubmitInput) => call(threadId, "t3_dream_submit", input);
          assert.isTrue(
            yield* call(caller, "t3_dream_submit", { suggestions }).pipe(
              Effect.match({ onFailure: () => true, onSuccess: (r) => r.isError === true }),
            ),
          );
          assert.isTrue(
            (yield* submit({
              suggestions: [{ ...proposed, sources: [{ ...source, threadId: caller }] }],
            })).isError,
          );
          assert.isTrue(
            (yield* submit({ suggestions: [{ ...proposed, expectedRevision: 2 }] })).isError,
          );
          assert.deepEqual((yield* submit({ suggestions })).structuredContent, {
            suggestionCount: 3,
          });
          assert.deepEqual((yield* submit({ suggestions })).structuredContent, {
            suggestionCount: 3,
          });
          assert.deepEqual(yield* dreams.results(caller), []);
          assert.lengthOf(yield* memory.history(key), 1);
          yield* sql`UPDATE orchestration_v2_projection_runs SET status='completed', completed_at='2026-11-17T01:30:00Z' WHERE thread_id = ${threadId}`;
          yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = ${source.messageId}`;
          const result = [
            {
              threadId,
              projectId,
              state: "ready" as const,
              suggestionCount: 3,
              completedAt: "2026-11-17T01:30:00Z",
            },
          ];
          assert.deepEqual(yield* dreams.results(caller), result);
          assert.deepEqual(yield* dreams.results(claimed.threadId), result);
          assert.deepEqual(yield* dreams.results(source.threadId), []);
          const detail = yield* dreams.review(threadId);
          assert.deepEqual(detail?.suggestions[0]?.original, {
            kind: before.kind,
            title: before.title,
            body: before.body,
          });
          assert.deepEqual(detail?.suggestions[0]?.sources, [
            { ...source, text: "Verified: retain the retry key across reconnects." },
          ]);
          yield* memory.save({
            ...before,
            id: "other",
            expectedRevision: 1,
            body: "A newer human decision.",
            commandId: CommandId.make("other-after"),
          });
          assert.strictEqual(
            (yield* dreams.decide({ threadId, suggestionId: "other", decision: "save" }))
              .suggestions[2]?.status,
            "stale",
          );
          const decision = { threadId, suggestionId: key.id, decision: "save" as const };
          const readOnlyGroup = WsRpcGroup.omit(
            ...[...WsRpcGroup.requests.keys()].filter(
              (
                tag,
              ): tag is Exclude<
                keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
                typeof WS_METHODS.forkDreamDecide
              > => tag !== WS_METHODS.forkDreamDecide,
            ),
          );
          const handler = readOnlyGroup.toLayerHandler(WS_METHODS.forkDreamDecide, dreams.decide);
          const rpc = (
            scopes: ReadonlyArray<
              typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope
            >,
          ) =>
            RpcTest.makeClient(readOnlyGroup).pipe(
              Effect.provide(Layer.merge(handler, RpcAuthorization.layer(scopes))),
            );
          const reader = yield* rpc([AuthOrchestrationReadScope]);
          assert.deepInclude(
            yield* reader[WS_METHODS.forkDreamDecide](decision).pipe(Effect.flip),
            { requiredPermission: AuthOrchestrationOperateScope },
          );
          const writer = yield* rpc([AuthOrchestrationOperateScope]);
          yield* Effect.all(
            [
              writer[WS_METHODS.forkDreamDecide](decision),
              writer[WS_METHODS.forkDreamDecide](decision),
            ],
            { concurrency: "unbounded" },
          );
          yield* dreams.decide({ threadId, suggestionId: "other", decision: "keep" });
          yield* dreams.decide({ threadId, suggestionId: "retry-log", decision: "save" });
        }).pipe(
          Effect.provide(
            McpHttpServer.toolkitRegistration(MemoryToolkit, MemoryHandlers.layer).pipe(
              Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
              Layer.provideMerge(services),
            ),
          ),
        );
      });
      yield* Effect.scoped(first.pipe(Effect.provide(db)));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { services } = yield* testServices;
          yield* Effect.gen(function* () {
            const dreams = yield* Dream.ForkDreamService;
            const memory = yield* Memory.ForkMemoryService;
            const review = yield* dreams.decide({
              threadId,
              suggestionId: key.id,
              decision: "save",
            });
            assert.deepEqual(
              review.suggestions.map((s) => s.status),
              ["saved", "saved", "kept"],
            );
            assert.lengthOf(yield* dreams.results(caller), 1);
            assert.lengthOf(yield* memory.history(key), 2);
            assert.strictEqual((yield* memory.get(key))?.body, proposed.body);
            assert.strictEqual((yield* memory.get({ ...key, id: "retry-log" }))?.revision, 1);
            assert.strictEqual(
              (yield* memory.get({ ...key, id: "other" }))?.body,
              "A newer human decision.",
            );
            assert.strictEqual(yield* memory.get({ projectId: null, id: key.id }), null);
          }).pipe(Effect.provide(services));
        }).pipe(Effect.provide(db)),
      );
    }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, NodeServices.layer))),
);
