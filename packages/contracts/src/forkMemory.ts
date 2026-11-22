import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const MemoryId = TrimmedNonEmptyString.check(Schema.isMaxLength(100));
const MemoryTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const MemoryBody = TrimmedNonEmptyString.check(Schema.isMaxLength(8000));
const MemoryReason = TrimmedNonEmptyString.check(Schema.isMaxLength(1000));

export const ForkMemorySourceRef = Schema.Struct({ threadId: ThreadId, messageId: MessageId });
export const ForkMemorySource = Schema.Struct({
  ...ForkMemorySourceRef.fields,
  text: Schema.String,
});

export const ForkMemoryKey = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  id: MemoryId,
});
export type ForkMemoryKey = typeof ForkMemoryKey.Type;

export const ForkMemory = Schema.Struct({
  ...ForkMemoryKey.fields,
  kind: Schema.Literals(["preference", "decision", "lesson", "fact"]),
  title: MemoryTitle,
  body: MemoryBody,
  revision: PositiveInt,
  sources: Schema.Array(ForkMemorySource),
  reason: MemoryReason,
  updatedAt: IsoDateTime,
});
export type ForkMemory = typeof ForkMemory.Type;

export const ForkMemorySummary = Schema.Struct({
  ...ForkMemoryKey.fields,
  kind: ForkMemory.fields.kind,
  title: MemoryTitle,
  excerpt: Schema.String,
  revision: PositiveInt,
  updatedAt: IsoDateTime,
});
export type ForkMemorySummary = typeof ForkMemorySummary.Type;

export const ForkMemorySaveInput = Schema.Struct({
  ...ForkMemoryKey.fields,
  commandId: CommandId,
  expectedRevision: NonNegativeInt,
  kind: ForkMemory.fields.kind,
  title: MemoryTitle,
  body: MemoryBody,
  sources: Schema.Array(ForkMemorySourceRef).check(Schema.isMaxLength(10)),
  reason: MemoryReason,
});
export type ForkMemorySaveInput = typeof ForkMemorySaveInput.Type;

export const ForkMemoryForgetInput = Schema.Struct({
  ...ForkMemoryKey.fields,
  expectedRevision: PositiveInt,
});
export type ForkMemoryForgetInput = typeof ForkMemoryForgetInput.Type;

export const ForkMemorySearchInput = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  query: Schema.String.check(Schema.isMaxLength(500)),
});
export type ForkMemorySearchInput = typeof ForkMemorySearchInput.Type;

/** Every scope in one environment; an empty query lists them all. */
export const ForkMemoryIndexInput = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(500)),
});
export type ForkMemoryIndexInput = typeof ForkMemoryIndexInput.Type;

export const ForkMemoryIndexEntry = Schema.Struct({
  ...ForkMemoryKey.fields,
  kind: ForkMemory.fields.kind,
  title: MemoryTitle,
  revision: PositiveInt,
  updatedAt: IsoDateTime,
});
export type ForkMemoryIndexEntry = typeof ForkMemoryIndexEntry.Type;

export class ForkMemoryError extends Schema.TaggedError<ForkMemoryError>()("ForkMemoryError", {
  reason: Schema.Literals([
    "storage",
    "invalid",
    "conflict",
    "not_found",
    "source_unavailable",
    "forgotten",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "storage":
        return "Could not access memory.";
      case "invalid":
        return "The memory request is invalid.";
      case "conflict":
        return "Memory changed. Read the current revision before editing it.";
      case "not_found":
        return "The project or memory was not found.";
      case "source_unavailable":
        return "A memory source is unavailable in this project.";
      case "forgotten":
        return "This memory was forgotten and cannot be restored by a retry.";
    }
  }
}
