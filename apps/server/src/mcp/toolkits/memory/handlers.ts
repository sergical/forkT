import {
  MAIN_COORDINATOR_MEMORY_SCOPE,
  isForkMainCoordinatorThreadId,
  OrchestratorMcpFailure,
  type ForkMemoryError,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ForkDreamService from "../../../project/ForkDreamService.ts";
import * as ForkCoordinatorService from "../../../project/ForkCoordinatorService.ts";
import * as ForkMemoryService from "../../../project/ForkMemoryService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { handoffProjectDeliverable } from "../../handoffProjectDeliverable.ts";
import { readCaller } from "../../threadAccess.ts";
import { MemoryToolkit } from "./tools.ts";

const failure = (error: ForkMemoryError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

const access = Effect.fn("ForkMemoryTool.access")(function* (projectId: ProjectId | null) {
  const { caller } = yield* readCaller();
  if (
    projectId === MAIN_COORDINATOR_MEMORY_SCOPE &&
    (caller === undefined || !isForkMainCoordinatorThreadId(caller.id))
  ) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Only the main coordinator can access its memories through agent tools.",
    });
  }
  return yield* ForkMemoryService.ForkMemoryService;
});

const dreamFailure = (error: { message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const refuseDreamWrite = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.thread?.threadId.startsWith("fork:dream:")
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Dreams can only propose changes for human review.",
          }),
        )
      : Effect.void,
  ),
);

export const layer = McpToolAccess.toLayer(MemoryToolkit, {
  t3_dream_submit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, caller } = yield* readCaller();
      if (
        !scope.thread ||
        !caller?.activeRunId ||
        scope.thread.subagent ||
        !scope.thread.threadId.startsWith("fork:dream:")
      )
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only the Dream's own session can submit this review.",
        });
      const dreams = yield* ForkDreamService.ForkDreamService;
      return yield* dreams
        .submit(scope.thread.threadId, caller.activeRunId, input)
        .pipe(Effect.mapError(dreamFailure));
    }),
  ),
  t3_dream_start: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const dreams = yield* ForkDreamService.ForkDreamService;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      return yield* dreams.start(input, scope.thread?.threadId).pipe(Effect.mapError(dreamFailure));
    }),
  ),
  t3_coordinator_open: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      if (input.handoff !== undefined) {
        if (
          input.global ||
          input.projectId !== undefined ||
          input.message !== undefined ||
          input.modelSelection !== undefined
        ) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "For a project handoff, pass global:false and put the project ID and source only in handoff.",
          });
        }
        return yield* handoffProjectDeliverable(input.handoff);
      }
      if (!input.global && input.message !== undefined) {
        const { thread } = yield* McpInvocationContext.McpInvocationContext;
        if (thread !== undefined && isForkMainCoordinatorThreadId(thread.threadId)) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "From Main, dispatch project work with global:false and handoff containing projectId, source and a stable requestId. This returns the project receipt.",
          });
        }
      }
      const coordinators = yield* ForkCoordinatorService.ForkCoordinatorService;
      return yield* coordinators
        .open(input)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
    }),
  ),
  t3_memory_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const memory = yield* access(input.projectId);
      const entries = yield* memory.search(input).pipe(Effect.mapError(failure));
      return entries.map(({ projectId, id, kind, title, revision, updatedAt }) => ({
        projectId,
        id,
        kind,
        title,
        revision,
        updatedAt,
      }));
    }),
  ),
  t3_memory_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const memory = yield* access(input.projectId);
      return {
        memory: yield* memory.get(input).pipe(Effect.mapError(failure)),
        history: input.history ? yield* memory.history(input).pipe(Effect.mapError(failure)) : [],
      };
    }),
  ),
  t3_memory_save: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      yield* refuseDreamWrite;
      const memory =
        input.projectId === MAIN_COORDINATOR_MEMORY_SCOPE
          ? yield* access(input.projectId)
          : yield* ForkMemoryService.ForkMemoryService;
      return yield* memory.save(input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_memory_forget: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      yield* refuseDreamWrite;
      const memory =
        input.projectId === MAIN_COORDINATOR_MEMORY_SCOPE
          ? yield* access(input.projectId)
          : yield* ForkMemoryService.ForkMemoryService;
      yield* memory.forget(input).pipe(Effect.mapError(failure));
      return { forgotten: true };
    }),
  ),
});
