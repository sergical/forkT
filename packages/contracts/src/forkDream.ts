import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ForkMemory, ForkMemorySaveInput, ForkMemorySource } from "./forkMemory.ts";

export const ForkDreamWording = Schema.Struct({
  kind: ForkMemory.fields.kind,
  title: ForkMemory.fields.title,
  body: ForkMemory.fields.body,
});

const proposalFields = {
  memoryId: ForkMemory.fields.id,
  expectedRevision: NonNegativeInt,
  reason: ForkMemory.fields.reason,
};

export const ForkDreamSubmitInput = Schema.Struct({
  suggestions: Schema.Array(
    Schema.Struct({
      ...proposalFields,
      ...ForkDreamWording.fields,
      sources: ForkMemorySaveInput.fields.sources.check(Schema.isMinLength(1)),
    }),
  ).check(Schema.isMaxLength(5)),
});
export type ForkDreamSubmitInput = typeof ForkDreamSubmitInput.Type;

export const ForkDreamSuggestion = Schema.Struct({
  ...proposalFields,
  suggestionId: ForkMemory.fields.id,
  action: Schema.Literals(["new", "update"]),
  original: Schema.NullOr(ForkDreamWording),
  proposed: ForkDreamWording,
  sources: Schema.Array(ForkMemorySource),
  status: Schema.Literals(["pending", "saved", "kept", "stale"]),
});
export type ForkDreamSuggestion = typeof ForkDreamSuggestion.Type;

export const ForkDreamThreadInput = Schema.Struct({ threadId: ThreadId });
export const ForkDreamDecideInput = Schema.Struct({
  threadId: ThreadId,
  suggestionId: ForkDreamSuggestion.fields.suggestionId,
  decision: Schema.Literals(["save", "keep"]),
});
export type ForkDreamDecideInput = typeof ForkDreamDecideInput.Type;

export const ForkDreamReview = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  state: Schema.Literals(["running", "ready", "incomplete", "legacy"]),
  sourceCount: NonNegativeInt,
  suggestions: Schema.Array(ForkDreamSuggestion),
});
export type ForkDreamReview = typeof ForkDreamReview.Type;

export const ForkDreamResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  state: Schema.Literals(["ready", "incomplete", "legacy"]),
  suggestionCount: NonNegativeInt,
  completedAt: IsoDateTime,
});
export type ForkDreamResult = typeof ForkDreamResult.Type;
