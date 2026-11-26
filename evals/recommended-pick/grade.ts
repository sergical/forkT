import type { Case } from "./cases.ts";

export interface Question {
  readonly question?: string;
  readonly options?: ReadonlyArray<{ readonly label?: string; readonly description?: string }>;
}

const TAG = /\(recommended\)\s*$/i;

/**
 * A pass marks exactly one option, picks the expected one, and names the memory when one
 * applies. When no memory applies, the reason must not mention memory at all.
 */
export function grade(entry: Case, question: Question | null) {
  const options = question?.options ?? [];
  const picks = options.filter((option) => TAG.test(option.label ?? ""));
  const pick = picks.length === 1 ? picks[0]! : null;
  const marked = pick !== null;
  const expected =
    pick !== null &&
    (entry.expect === undefined || (pick.label ?? "").toLowerCase().includes(entry.expect));
  const reason = (pick?.description ?? "").toLowerCase();
  const namedMemory =
    entry.memoryWord === undefined
      ? pick !== null && !/\bmemory\b|\bremember/.test(reason)
      : reason.includes(entry.memoryWord);
  const verdict =
    question === null
      ? "no question"
      : !marked
        ? `${picks.length} picks`
        : expected && namedMemory
          ? "pass"
          : !expected
            ? "other pick"
            : entry.memoryWord === undefined
              ? "claims a memory"
              : "reason misses memory";
  return { marked, expected, namedMemory, verdict };
}
