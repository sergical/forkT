import type { ForkDreamResult, ForkDreamReview, ForkDreamSuggestion } from "@t3tools/contracts";
import { msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export const dreamMemoryKinds = {
  preference: msg("Preference"),
  decision: msg("Decision"),
  lesson: msg("Lesson"),
  fact: msg("Fact"),
};

export const dreamDecisions = {
  saved: msg("Saved"),
  kept: msg("Kept as is"),
  stale: msg("This memory changed after the review. This suggestion can no longer be saved."),
} satisfies Record<Exclude<ForkDreamSuggestion["status"], "pending">, string>;

export function dreamResultLabel(result: ForkDreamResult, m: MFunctionType) {
  if (result.state === "legacy") return m(msg("Read earlier Dream review"));
  if (result.state === "incomplete") return m(msg("Dream review incomplete"));
  return result.suggestionCount === 0
    ? m(msg("Reviewed. No changes recommended."))
    : m(msg("Review {count, plural, one {{count} suggestion} other {{count} suggestions}}"), {
        count: result.suggestionCount,
      });
}

export function dreamReviewNote(review: ForkDreamReview, m: MFunctionType) {
  switch (review.state) {
    case "running":
      return m(msg("Dream is reviewing this project."));
    case "legacy":
      return m(
        msg(
          "This earlier Dream wrote its review in the conversation. It has no recorded decisions.",
        ),
      );
    case "incomplete":
      return m(msg("Dream ended without a complete review. See the conversation for details."));
    case "ready":
      return review.suggestions.length === 0 ? m(msg("Reviewed. No changes recommended.")) : null;
  }
}
