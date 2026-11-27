import { ForkDreamService } from "../../../project/ForkDreamService.ts";
import { ForkCoordinatorService } from "../../../project/ForkCoordinatorService.ts";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ForkMemoryError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ForkMemoryService from "../../../project/ForkMemoryService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as MemoryHandlers from "./handlers.ts";
import { MemoryToolkit } from "./tools.ts";

it.effect.each([
  { runtimeMode: "full-access", interactionMode: "default", active: true, allowed: true },
  { runtimeMode: "approval-required", interactionMode: "default", active: true, allowed: false },
  { runtimeMode: "full-access", interactionMode: "plan", active: true, allowed: false },
  { runtimeMode: "full-access", interactionMode: "default", active: false, allowed: false },
  {
    runtimeMode: "full-access",
    interactionMode: "default",
    active: true,
    allowed: false,
    dream: true,
  },
] as const)("protects shared memory writes: %j", (scenario) =>
  Effect.gen(function* () {
    const { runtimeMode, interactionMode, active, allowed } = scenario;
    const threadId = ThreadId.make(
      "dream" in scenario ? "fork:dream:memory-caller" : "memory-caller",
    );
    let writes = 0;
    const dependencies = Layer.mergeAll(
      Layer.mock(ForkCoordinatorService)({}),
      Layer.mock(ForkDreamService)({}),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("memory-environment"),
        requestNamespace: "provider:memory",
        thread: {
          threadId,
          providerSessionId: "memory-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed(
            liveThreadShell(threadId, {
              runtimeMode,
              interactionMode,
              ...(active ? {} : { activeRunId: null }),
            }),
          ),
      }),
      Layer.mock(ForkMemoryService.ForkMemoryService)({
        save: () =>
          Effect.sync(() => {
            writes++;
          }).pipe(Effect.andThen(Effect.fail(new ForkMemoryError({ reason: "conflict" })))),
      }),
    );
    const response = yield* Effect.gen(function* () {
      const toolkit = yield* MemoryToolkit;
      return yield* toolkit
        .handle("t3_memory_save", {
          projectId: ProjectId.make("project-memory"),
          id: "decision",
          commandId: CommandId.make("memory-save"),
          expectedRevision: 0,
          kind: "decision",
          title: "Decision",
          body: "Use the agreed approach.",
          reason: "User correction.",
          sources: [{ threadId, messageId: MessageId.make("correction") }],
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
        );
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(MemoryHandlers.layer).pipe(
          Layer.provideMerge(dependencies),
        ),
      ),
    );
    expect(writes).toBe(allowed ? 1 : 0);
    if (allowed)
      expect(response).toMatchObject({
        code: "invalid_request",
        message: "Memory changed. Read the current revision before editing it.",
      });
    else expect(response).toHaveProperty("code");
  }),
);
