import * as Schema from "effect/Schema";
import { CommandId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const ForkCoordinatorOpenInput = Schema.Struct({
  projectId: ProjectId,
  global: Schema.Boolean,
  modelSelection: Schema.optional(ModelSelection),
  /** Sent to the coordinator as a user turn once it is open. */
  message: Schema.optional(
    Schema.Struct({
      commandId: CommandId,
      text: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
    }),
  ),
});
export type ForkCoordinatorOpenInput = typeof ForkCoordinatorOpenInput.Type;

export const ForkCoordinator = Schema.Struct({
  projectId: ProjectId,
  global: Schema.Boolean,
  threadId: ThreadId,
});
export type ForkCoordinator = typeof ForkCoordinator.Type;

export const ForkDreamInput = Schema.Struct({ projectId: ProjectId, commandId: CommandId });
export type ForkDreamInput = typeof ForkDreamInput.Type;

export const ForkDream = Schema.Struct({
  threadId: ThreadId,
  reused: Schema.Boolean,
  sourceCount: Schema.Number,
});
export type ForkDream = typeof ForkDream.Type;

export class ForkCoordinatorError extends Schema.TaggedError<ForkCoordinatorError>()(
  "ForkCoordinatorError",
  {
    message: Schema.String,
  },
) {}
