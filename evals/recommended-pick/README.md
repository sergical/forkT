# Recommended pick

Measures whether worker agents mark the option they would choose when they ask the user a question, so the Inbox can show and preselect it. Each case runs with and without `T3_CODE_QUESTION_GUIDANCE` (the line in the orchestration instructions every T3 agent gets) and the turn's memory brief, built by the server's own `buildMemoryBrief`.

## Run

```sh
cd evals
pnpm recommended-pick --out runs/pick
pnpm recommended-pick --out runs/pick --model claude:sonnet --model codex:gpt-6.2-sol --samples 3
```

- It uses your local `claude` and `codex` logins.
- `--case <id>` limits the run; repeat it for several cases.
- A run writes `results.json` (every answer and its grade) and `summary.txt`.

## Grading

A pass marks exactly one option with "(Recommended)", picks the expected option, and names the saved memory in its reason when one applies. When no memory applies, the reason must not claim one.

## Add a case

Add an entry to `cases.ts`: the saved memories, the user's request, the decision to ask about, a word the right pick's label contains, and, if a memory applies, a word from it the reason should name.

## Cost

Each run is 4 cases × 2 arms × samples × models short prompts: 48 calls with the defaults, a few cents on a plan.
