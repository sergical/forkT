import * as Schema from "effect/Schema";
import { CommandId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const ForkCoordinatorOpenInput = Schema.Struct({
  /** The main coordinator (`global`) needs none: it lives in the scratch workspace. */
  projectId: Schema.optional(ProjectId),
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

/** The main coordinator's thread is `fork:global:<generation>`; see ForkCoordinatorStore. */
export const isForkMainCoordinatorThreadId = (threadId: string) =>
  threadId.startsWith("fork:global:");

/** A project coordinator's thread is `fork:project:<projectId>:<generation>`. */
export const forkCoordinatorProjectId = (threadId: string): string | null => {
  const match = /^fork:project:(.+):\d+$/.exec(threadId);
  return match ? match[1]! : null;
};

/** The coordinator owns its descendants through their persisted root thread id. */
export const isForkCoordinatorThreadId = (threadId: string): boolean =>
  isForkMainCoordinatorThreadId(threadId) || forkCoordinatorProjectId(threadId) !== null;

export const ForkRoutingWindow = Schema.Struct({
  label: Schema.String,
  remainingPercent: Schema.Number,
  resetsAt: Schema.NullOr(Schema.String),
  modelIds: Schema.optionalKey(Schema.Array(Schema.String)),
  providerIds: Schema.optionalKey(Schema.Array(Schema.String)),
  modelScope: Schema.optionalKey(Schema.String),
});

export const ForkRoutingRecommendation = Schema.Struct({
  selection: Schema.NullOr(ModelSelection),
  reason: Schema.String,
  limitingWindow: Schema.optionalKey(ForkRoutingWindow),
});

export const ForkCoordinator = Schema.Struct({
  projectId: ProjectId,
  global: Schema.Boolean,
  threadId: ThreadId,
  routing: Schema.optionalKey(ForkRoutingRecommendation),
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
