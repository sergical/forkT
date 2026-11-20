import { OrchestratorMcpFailure, type ForkMemoryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ForkDreamService from "../../../project/ForkDreamService.ts";
import * as ForkCoordinatorService from "../../../project/ForkCoordinatorService.ts";
import * as ForkMemoryService from "../../../project/ForkMemoryService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { MemoryToolkit } from "./tools.ts";

const failure = (error: ForkMemoryError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* ForkMemoryService.ForkMemoryService;
});

export const layer = McpToolAccess.toLayer(MemoryToolkit, {
  t3_dream_start: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const dreams = yield* ForkDreamService.ForkDreamService;
      return yield* dreams
        .start(input)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
    }),
  ),
  t3_coordinator_open: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
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
      const memory = yield* access;
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
      const memory = yield* access;
      return {
        memory: yield* memory.get(input).pipe(Effect.mapError(failure)),
        history: input.history ? yield* memory.history(input).pipe(Effect.mapError(failure)) : [],
      };
    }),
  ),
  t3_memory_save: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const memory = yield* ForkMemoryService.ForkMemoryService;
      return yield* memory.save(input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_memory_forget: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const memory = yield* ForkMemoryService.ForkMemoryService;
      yield* memory.forget(input).pipe(Effect.mapError(failure));
      return { forgotten: true };
    }),
  ),
});
