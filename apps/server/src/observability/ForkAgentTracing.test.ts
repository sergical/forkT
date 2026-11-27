import { assert, it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ForkTurnMessages from "./ForkTurnMessages.ts";
import * as ForkAgentTracing from "./ForkAgentTracing.ts";

const at = (ms: number) => DateTime.makeUnsafe(1_800_000_000_000 + ms);
const stored = (event: object) =>
  ({
    sequence: 1,
    commandId: null,
    event: { threadId: "thread-1", occurredAt: at(1_000), ...event },
  }) as OrchestrationV2StoredEvent;

const run = (status: string, completedAt: number | null) => ({
  type: "run.updated",
  threadId: "thread-1",
  runId: "run-1",
  occurredAt: at(completedAt ?? 0),
  payload: {
    id: "run-1",
    threadId: "thread-1",
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
    userMessageId: "message-1",
    status,
    startedAt: at(0),
    completedAt: completedAt === null ? null : at(completedAt),
  },
});

it.effect("turns one run's events into gen_ai spans under the request that sent it", () =>
  Effect.gen(function* () {
    const ended: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          ended.push(span);
        };
        return span;
      },
    });

    ForkAgentTracing.startRecordingOrigins();
    const request = yield* Effect.gen(function* () {
      yield* ForkAgentTracing.recordOrigins([
        {
          type: "message.updated",
          payload: { id: "message-1", role: "user" },
        } as never,
      ]);
      return yield* Effect.currentSpan;
    }).pipe(Effect.withSpan("ws.rpc.orchestration.dispatchCommand"), Effect.withTracer(tracer));

    const tracing = yield* ForkAgentTracing.make("test-environment").pipe(
      Effect.withTracer(tracer),
    );
    yield* tracing.onEvent(stored(run("running", null)));
    yield* tracing.onEvent(
      stored({
        type: "provider-turn.updated",
        runId: "run-1",
        payload: {
          id: "turn-1",
          status: "completed",
          model: "claude-haiku-5-5",
          startedAt: at(10),
          completedAt: at(600),
          turnTokenUsage: { inputTokens: 1191, cachedInputTokens: 900, outputTokens: 20 },
          tokenUsage: { usedTokens: 50_000, maxTokens: 200_000 },
        },
      }),
    );
    const command = {
      id: "item-1",
      providerTurnId: "turn-1",
      type: "command_execution",
      runId: "run-1",
      input: "echo hi",
      startedAt: at(600),
      completedAt: at(900),
    };
    yield* tracing.onEvent(
      stored({ type: "turn-item.updated", payload: { ...command, status: "running" } }),
    );
    yield* tracing.onEvent(
      stored({ type: "turn-item.updated", payload: { ...command, status: "completed" } }),
    );
    yield* tracing.onEvent(
      stored({ type: "turn-item.updated", payload: { ...command, status: "completed" } }),
    );
    yield* tracing.onEvent(
      stored({
        type: "runtime-request.updated",
        runId: "run-1",
        payload: {
          id: "request-1",
          kind: "command",
          status: "resolved",
          decision: "accept",
          createdAt: at(620),
          resolvedAt: at(850),
        },
      }),
    );
    yield* tracing.onEvent(stored(run("completed", 1_000)));

    const byName = new Map(ended.map((span) => [span.name, span]));
    assert.deepStrictEqual(
      ended.map((span) => span.name),
      [
        "ws.rpc.orchestration.dispatchCommand",
        "chat claude-haiku-5-5",
        "execute_tool command",
        "fork.decision",
        "fork.run",
      ],
    );
    const agent = byName.get("fork.run")!;
    assert.strictEqual(Option.getOrUndefined(agent.parent)?.spanId, request.spanId);
    assert.strictEqual(agent.attributes.get("sentry.op"), "gen_ai.invoke_agent");
    assert.strictEqual(agent.attributes.get("gen_ai.request.model"), "claude-haiku-5-5");
    assert.strictEqual(
      agent.status._tag === "Ended" && agent.status.endTime,
      1_800_000_001_000_000_000n,
    );

    const chat = byName.get("chat claude-haiku-5-5")!;
    assert.strictEqual(Option.getOrUndefined(chat.parent)?.spanId, agent.spanId);
    assert.strictEqual(chat.attributes.get("gen_ai.usage.input_tokens"), 1191);
    assert.strictEqual(chat.attributes.get("gen_ai.usage.input_tokens.cached"), 900);
    assert.strictEqual(chat.attributes.get("gen_ai.context.utilization"), 0.25);

    const tool = byName.get("execute_tool command")!;
    assert.isFalse(tool.attributes.has("gen_ai.tool.input"));
    assert.strictEqual(
      byName.get("fork.decision")!.attributes.get("fork.decision.decision"),
      "accept",
    );
  }),
);

it.effect("keeps late tools on their finished run and ignores re-saved old records", () =>
  Effect.gen(function* () {
    const ended: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          ended.push(span);
        };
        return span;
      },
    });
    const tracing = yield* ForkAgentTracing.make("test-environment").pipe(
      Effect.withTracer(tracer),
    );
    yield* tracing.onEvent(stored(run("running", null)));
    yield* tracing.onEvent(stored(run("completed", 1_000)));
    const background = {
      id: "item-late",
      providerTurnId: "turn-1",
      type: "command_execution",
      runId: "run-1",
      input: "sleep 5",
      status: "completed",
      startedAt: at(900),
      completedAt: at(6_000),
    };
    yield* tracing.onEvent(
      stored({ type: "turn-item.updated", occurredAt: at(6_000), payload: background }),
    );
    // An old run and tool saved again an hour later, as a rollback rewrite does.
    const later = { ...run("rolled_back", 1_000), occurredAt: at(3_600_000) };
    yield* tracing.onEvent(
      stored({ ...later, runId: "run-2", payload: { ...later.payload, id: "run-2" } }),
    );
    yield* tracing.onEvent(
      stored({
        type: "turn-item.updated",
        occurredAt: at(3_600_000),
        payload: { ...background, id: "item-old" },
      }),
    );

    assert.deepStrictEqual(
      ended.map((span) => span.name),
      ["fork.run", "execute_tool command"],
    );
    const [agent, tool] = ended;
    assert.strictEqual(Option.getOrUndefined(tool!.parent)?.spanId, agent!.spanId);
    assert.strictEqual(tool!.attributes.get("t3.thread.id"), "thread-1");
  }),
);

it.effect(
  "traces each record once while its updates are still fresh, however many others pass",
  () =>
    Effect.gen(function* () {
      let count = 0;
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            count += 1;
          };
          return span;
        },
      });
      const tracing = yield* ForkAgentTracing.make("test-environment").pipe(
        Effect.withTracer(tracer),
      );
      const item = (id: number) =>
        stored({
          type: "turn-item.updated",
          payload: {
            id: `item-${id}`,
            providerTurnId: "turn-1",
            type: "command_execution",
            runId: null,
            input: "true",
            status: "completed",
            startedAt: at(0),
            completedAt: at(500),
          },
        });
      for (let id = 0; id < 25_000; id += 1) yield* tracing.onEvent(item(id));
      yield* tracing.onEvent(item(0));
      assert.strictEqual(count, 25_000);
    }),
);

it.effect("exports visible messages once on their own provider turn with consent at emission", () =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const read = yield* ForkTurnMessages.make(at(0));
    const tracing = yield* ForkAgentTracing.make("test-environment", read).pipe(
      Effect.withTracer(tracer),
    );
    const threadId = ThreadId.make("thread-1");
    const runId = RunId.make("run-1");
    const commit = Effect.fnUntraced(function* (event: object) {
      const record = stored({ threadId, runId, ...event });
      yield* projections.apply(record.event);
      yield* tracing.onEvent(record);
    });
    const consent = (sentryTextConsent: OrchestrationV2AppThread["sentryTextConsent"]) =>
      commit({
        type: "thread.created",
        payload: {
          id: threadId,
          projectId: "project",
          title: "Tracing",
          createdBy: "user",
          creationSource: "web",
          providerInstanceId: "codex",
          modelSelection: { instanceId: "codex", model: "gpt-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: at(0),
          updatedAt: at(0),
          archivedAt: null,
          settledAt: null,
          settledOverride: null,
          lastVisitedAt: null,
          deletedAt: null,
          sentryTextConsent,
        },
      });
    const turn = (ordinal: number, status: "running" | "completed" | "interrupted") =>
      commit({
        type: "provider-turn.updated",
        payload: {
          id: `turn-${ordinal}`,
          nodeId: "root",
          providerThreadId: "provider-thread",
          runAttemptId: "attempt",
          nativeTurnRef: null,
          ordinal,
          status,
          startedAt: at(ordinal * 100),
          completedAt: status === "running" ? null : at(ordinal * 100 + 50),
        },
      });
    const message = (
      id: string,
      role: "user" | "assistant",
      time: number,
      fields: Partial<OrchestrationV2ConversationMessage> = {},
    ) =>
      commit({
        type: "message.updated",
        payload: {
          id: MessageId.make(id),
          threadId,
          runId,
          nodeId: null,
          role,
          text: id,
          createdBy: role === "user" ? "user" : "agent",
          creationSource: role === "user" ? "web" : "provider",
          streaming: false,
          createdAt: at(time),
          updatedAt: at(time),
          attachments: [
            {
              id: "attachment",
              type: "file",
              name: "private-attachment",
              mimeType: "text/plain",
              sizeBytes: 16,
            },
          ],
          ...fields,
        },
      });
    const item = (
      id: string,
      ordinal: number,
      providerTurn: number | null,
      phase?: "final_answer" | "commentary",
    ) =>
      commit({
        type: "turn-item.updated",
        payload: {
          id: `item-${id}`,
          threadId,
          runId,
          nodeId: "root",
          providerThreadId: "provider-thread",
          providerTurnId: providerTurn === null ? null : `turn-${providerTurn}`,
          parentItemId: null,
          nativeItemRef: null,
          ordinal,
          title: null,
          status: "completed",
          startedAt: at(ordinal),
          completedAt: at(ordinal),
          updatedAt: at(ordinal),
          messageId: id,
          text: id,
          ...(phase
            ? { type: "assistant_message", phase, streaming: false }
            : {
                type: "user_message",
                inputIntent: providerTurn === null ? "queued_turn" : "steer",
                createdBy: "user",
                creationSource: "web",
                attachments: [],
              }),
        },
      });
    yield* consent(null);
    yield* message("before-consent", "user", 9);
    yield* consent({ threadId, since: DateTime.formatIso(at(10)) });
    yield* message("queued", "user", 11);
    yield* item("queued", 1, null);
    yield* tracing.onEvent(stored(run("running", null)));
    yield* turn(1, "running");
    yield* message("comment", "assistant", 101);
    yield* item("comment", 2, 1, "commentary");
    yield* message("steer", "user", 102, { creationSource: "mobile" });
    yield* item("steer", 3, 1);
    yield* message("answer", "assistant", 103, { text: "unfinished", streaming: true });
    yield* item("answer", 4, 1, "final_answer");
    yield* turn(1, "completed");
    yield* message("answer", "assistant", 103);
    yield* turn(2, "running");
    yield* turn(1, "completed");
    yield* message("automated", "user", 202, { createdBy: "agent", creationSource: "mcp" });
    yield* item("automated", 5, 2);
    // Promotion rewrites the queued message with the steer's creation time.
    yield* message("before-consent", "user", 204);
    yield* item("before-consent", 6, 2);
    yield* message("second reply", "assistant", 205);
    yield* item("second reply", 7, 2, "commentary");
    yield* turn(2, "completed");
    yield* turn(3, "running");
    yield* message("revoked", "user", 301);
    yield* item("revoked", 8, 3);
    yield* turn(3, "interrupted");
    yield* consent(null);
    yield* tracing.onEvent(stored(run("interrupted", 350)));

    const chats = () => spans.filter((span) => span.attributes.get("sentry.op") === "gen_ai.chat");
    const messages = (span: Tracer.NativeSpan, side: "input" | "output") =>
      JSON.parse(String(span.attributes.get(`gen_ai.${side}.messages`) ?? "[]")) as unknown[];
    assert.deepEqual(
      chats().map((span) => [messages(span, "input"), messages(span, "output")]),
      [
        [
          [
            { role: "user", content: "queued", ordinal: 1 },
            { role: "user", content: "steer", ordinal: 3 },
          ],
          [
            { role: "assistant", content: "comment", ordinal: 2, phase: "commentary" },
            { role: "assistant", content: "answer", ordinal: 4, phase: "final_answer" },
          ],
        ],
        [[], [{ role: "assistant", content: "second reply", ordinal: 7, phase: "commentary" }]],
        [[], []],
      ],
    );
    assert.deepEqual(
      spans.map((span) => span.attributes.get("sentry.op")),
      ["gen_ai.invoke_agent", "gen_ai.chat", "gen_ai.chat", "gen_ai.chat"],
    );
    assert.strictEqual(chats()[2]!.attributes.get("t3.provider_turn.status"), "interrupted");
    assert.isFalse(chats()[2]!.attributes.has("gen_ai.input.messages"));
  }).pipe(
    Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);

it.effect("records a failed start without reporting an AI operation", () =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const tracing = yield* ForkAgentTracing.make("test-environment").pipe(
      Effect.withTracer(tracer),
    );
    yield* tracing.onEvent(stored(run("running", null)));
    yield* tracing.onEvent(
      stored({
        type: "turn-item.updated",
        payload: {
          id: "setup",
          runId: "run-1",
          threadId: "thread-1",
          providerTurnId: null,
          type: "command_execution",
          status: "failed",
          startedAt: at(0),
          completedAt: at(100),
          input: "private setup command",
        },
      }),
    );
    yield* tracing.onEvent(stored(run("failed", 100)));
    assert.deepEqual(
      spans.map((span) => span.attributes.get("sentry.op")),
      ["fork.run", "fork.command_execution"],
    );
    assert.strictEqual(spans[0]?.attributes.get("t3.run.status"), "failed");
  }),
);

it.effect("keeps identically named Main conversations from separate environments apart", () =>
  Effect.gen(function* () {
    const main = run("completed", 1000);
    main.payload.threadId = "fork:global:1";
    const conversations: unknown[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          conversations.push(span.attributes.get("gen_ai.conversation.id"));
          end(time, exit);
        };
        return span;
      },
    });
    for (const environment of ["first", "second", "first"]) {
      const tracing = yield* ForkAgentTracing.make(environment).pipe(Effect.withTracer(tracer));
      yield* tracing.onEvent(stored(main));
    }
    assert.isString(conversations[0]);
    assert.notStrictEqual(conversations[0], conversations[1]);
    assert.strictEqual(conversations[0], conversations[2]);
  }),
);
