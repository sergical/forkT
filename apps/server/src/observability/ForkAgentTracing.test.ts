import { assert, it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import * as ForkAgentTracing from "./ForkAgentTracing.ts";

const at = (ms: number) => DateTime.makeUnsafe(1_800_000_000_000 + ms);
const stored = (event: object) =>
  ({
    sequence: 1,
    commandId: null,
    event: { occurredAt: at(1_000), ...event },
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
    tracing.onEvent(stored(run("running", null)));
    tracing.onEvent(
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
      type: "command_execution",
      runId: "run-1",
      input: "echo hi",
      startedAt: at(600),
      completedAt: at(900),
    };
    tracing.onEvent(
      stored({ type: "turn-item.updated", payload: { ...command, status: "running" } }),
    );
    tracing.onEvent(
      stored({ type: "turn-item.updated", payload: { ...command, status: "completed" } }),
    );
    tracing.onEvent(
      stored({ type: "turn-item.updated", payload: { ...command, status: "completed" } }),
    );
    tracing.onEvent(
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
    tracing.onEvent(stored(run("completed", 1_000)));

    const byName = new Map(ended.map((span) => [span.name, span]));
    assert.deepStrictEqual(
      ended.map((span) => span.name),
      [
        "ws.rpc.orchestration.dispatchCommand",
        "chat claude-haiku-5-5",
        "execute_tool command",
        "fork.decision",
        "invoke_agent claudeAgent",
      ],
    );
    const agent = byName.get("invoke_agent claudeAgent")!;
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
    tracing.onEvent(stored(run("running", null)));
    tracing.onEvent(stored(run("completed", 1_000)));
    const background = {
      id: "item-late",
      type: "command_execution",
      runId: "run-1",
      input: "sleep 5",
      status: "completed",
      startedAt: at(900),
      completedAt: at(6_000),
    };
    tracing.onEvent(
      stored({ type: "turn-item.updated", occurredAt: at(6_000), payload: background }),
    );
    // An old run and tool saved again an hour later, as a rollback rewrite does.
    const later = { ...run("rolled_back", 1_000), occurredAt: at(3_600_000) };
    tracing.onEvent(
      stored({ ...later, runId: "run-2", payload: { ...later.payload, id: "run-2" } }),
    );
    tracing.onEvent(
      stored({
        type: "turn-item.updated",
        occurredAt: at(3_600_000),
        payload: { ...background, id: "item-old" },
      }),
    );

    assert.deepStrictEqual(
      ended.map((span) => span.name),
      ["invoke_agent claudeAgent", "execute_tool command"],
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
            type: "command_execution",
            runId: null,
            input: "true",
            status: "completed",
            startedAt: at(0),
            completedAt: at(500),
          },
        });
      for (let id = 0; id < 25_000; id += 1) tracing.onEvent(item(id));
      tracing.onEvent(item(0));
      assert.strictEqual(count, 25_000);
    }),
);

it.effect("shares only new visible messages from the conversation that opted in", () =>
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
    const threadId = ThreadId.make("chosen");
    const share = (
      id: string,
      fields: Partial<OrchestrationV2ConversationMessage> = {},
      enabled = true,
    ) => {
      tracing.captureMessage(
        {
          id: MessageId.make(id),
          text: id,
          role: "user",
          threadId,
          runId: RunId.make("run"),
          nodeId: null,
          createdBy: "user",
          creationSource: "web",
          streaming: false,
          createdAt: at(2),
          updatedAt: at(3),
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
        enabled ? { threadId, since: DateTime.formatIso(at(1)) } : null,
      );
    };
    share("before", { createdAt: at(0) });
    share("disabled", {}, false);
    share("worker", { threadId: ThreadId.make("worker-thread") });
    share("hidden-thought", { role: "system" });
    share("injected", { createdBy: "agent", creationSource: "mcp" });
    ForkAgentTracing.startRecordingOrigins();
    const request = yield* Effect.gen(function* () {
      yield* ForkAgentTracing.recordOrigins([
        { type: "message.updated", payload: { id: "visible-steer", role: "user" } } as never,
      ]);
      return yield* Effect.currentSpan;
    }).pipe(Effect.withSpan("ws.rpc.orchestration.dispatchCommand", { root: true }));
    share("visible-steer");
    assert.strictEqual(spans[0]?.traceId, request.traceId);
    share("visible-answer", { role: "assistant", createdBy: "agent", creationSource: "provider" });
    assert.deepEqual(
      spans.map((span) => [
        span.attributes.get("gen_ai.input.messages"),
        span.attributes.get("gen_ai.output.messages"),
      ]),
      [
        [JSON.stringify([{ role: "user", content: "visible-steer" }]), undefined],
        [undefined, JSON.stringify([{ role: "assistant", content: "visible-answer" }])],
      ],
    );
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
      tracing.onEvent(stored(main));
    }
    assert.isString(conversations[0]);
    assert.notStrictEqual(conversations[0], conversations[1]);
    assert.strictEqual(conversations[0], conversations[2]);
  }),
);
