import * as Schema from "effect/Schema";
import {
  CommandId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import type { OrchestrationV2TurnItem } from "./orchestrationV2.ts";
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

const projectReturnPrefix = "message:project-handoff-return:";
const projectReturnItemPrefix = `turn-item:message:${encodeURIComponent(projectReturnPrefix)}`;

export const forkProjectReturnMessageId = (runId: RunId) =>
  MessageId.make(projectReturnPrefix + runId);

/** Legacy and new returns share this stable notification ID. Only the server can verify the handoff. */
export function forkProjectReturnRunId(item: OrchestrationV2TurnItem): RunId | null {
  if (
    item.type !== "notification" ||
    item.source.kind !== "system" ||
    !isForkMainCoordinatorThreadId(item.threadId) ||
    !item.id.startsWith(projectReturnItemPrefix)
  )
    return null;
  try {
    const id = decodeURIComponent(item.id.slice(projectReturnItemPrefix.length));
    return id.trim() ? RunId.make(id) : null;
  } catch {
    return null;
  }
}

/** A project coordinator's thread is `fork:project:<projectId>:<generation>`. */
export const forkCoordinatorProjectId = (threadId: string): string | null => {
  const match = /^fork:project:(.+):\d+$/.exec(threadId);
  return match ? match[1]! : null;
};

/** The coordinator owns its descendants through their persisted root thread id. */
export const isForkCoordinatorThreadId = (threadId: string): boolean =>
  isForkMainCoordinatorThreadId(threadId) || forkCoordinatorProjectId(threadId) !== null;

/** Coordinator identity takes precedence over a legacy ordinary pin. */
export function forkSidebarThreadRole(thread: { id: string; pinnedAt?: string | null }) {
  if (isForkCoordinatorThreadId(thread.id)) return "coordinator";
  return thread.pinnedAt == null ? "thread" : "pinned";
}

/** Fork routing accepts saved Claude exclusions from before the driver was identified as claudeAgent. */
export const forkRoutingDriverKind = (driver: string): string =>
  driver === "claude" ? "claudeAgent" : driver;

export const isForkRoutingDriverExcluded = (
  driver: string,
  excludedDrivers: readonly string[],
): boolean =>
  excludedDrivers.some(
    (excluded) => forkRoutingDriverKind(excluded) === forkRoutingDriverKind(driver),
  );

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
