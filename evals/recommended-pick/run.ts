#!/usr/bin/env node
// An eval script, not server code: it runs the local Claude and Codex CLIs.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { T3_CODE_QUESTION_GUIDANCE } from "../../packages/provider-core/src/server/orchestrationInstructions.ts";
import { buildMemoryBrief } from "../../apps/server/src/project/forkMemoryBrief.ts";
import { cases, type Case } from "./cases.ts";
import { grade, type Question } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", multiple: true },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
  },
});
if (!values.out) throw new Error("Use --out <directory> [--model claude:<id>|codex:<id>].");
const models = values.model ?? ["claude:sonnet", "codex:gpt-6.2-sol"];
const selected = values.case ? cases.filter((entry) => values.case!.includes(entry.id)) : cases;
const samples = Number(values.samples);

/** The turn text a forkT worker sees, built from the server's own guidance and memory brief. */
function prompt(entry: Case, guided: boolean) {
  const brief = buildMemoryBrief(
    entry.memories.map(([title, body], index) => ({
      projectId: null,
      id: `memory-${index}`,
      kind: "preference",
      title,
      body,
      revision: 1,
      sources: [],
      reason: "Saved by the user.",
      updatedAt: "2026-11-20T10:00:00.000Z",
    })),
  ).text;
  return [
    guided ? T3_CODE_QUESTION_GUIDANCE : "",
    brief,
    entry.request,
    `Before you change anything, ask me one single-choice question: ${entry.decision}`,
    'Reply with only the question as JSON: {"question": string, "options": [{"label": string, "description": string}]}.',
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

function ask(model: string, text: string): string {
  const [cli, id] = model.split(":") as [string, string];
  if (cli === "claude") {
    const run = NodeChildProcess.spawnSync("claude", ["-p", "--model", id, text], {
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    return run.stdout;
  }
  const file = NodePath.join(NodeOS.tmpdir(), `recommended-pick-${process.pid}.txt`);
  NodeChildProcess.spawnSync(
    "codex",
    ["exec", "--model", id, "--skip-git-repo-check", "--output-last-message", file, text],
    { encoding: "utf8", maxBuffer: 1 << 24, cwd: NodeOS.tmpdir() },
  );
  const answer = NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : "";
  NodeFS.rmSync(file, { force: true });
  return answer;
}

function parse(output: string): Question | null {
  const json = output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  try {
    return JSON.parse(json) as Question;
  } catch {
    return null;
  }
}

NodeFS.mkdirSync(values.out, { recursive: true });
const rows: Array<
  {
    readonly model: string;
    readonly guided: boolean;
    readonly marked: boolean;
    readonly expected: boolean;
    readonly namedMemory: boolean;
  } & Record<string, unknown>
> = [];
for (const model of models) {
  for (const entry of selected) {
    for (const guided of [false, true]) {
      for (let sample = 0; sample < samples; sample++) {
        const output = ask(model, prompt(entry, guided));
        const result = grade(entry, parse(output));
        rows.push({ model, case: entry.id, guided, sample, ...result, output });
        console.log(
          `${model} ${entry.id} ${guided ? "guided" : "baseline"} #${sample}: ${result.verdict}`,
        );
      }
    }
  }
}
NodeFS.writeFileSync(NodePath.join(values.out, "results.json"), JSON.stringify(rows, null, 2));
const summary = models.flatMap((model) =>
  [false, true].map((guided) => {
    const mine = rows.filter((row) => row.model === model && row.guided === guided);
    const count = (key: "marked" | "expected" | "namedMemory") =>
      `${mine.filter((row) => row[key]).length}/${mine.length}`;
    return `${model} ${guided ? "guided  " : "baseline"}  one pick ${count("marked")}  right pick ${count("expected")}  names memory ${count("namedMemory")}`;
  }),
);
NodeFS.writeFileSync(NodePath.join(values.out, "summary.txt"), summary.join("\n") + "\n");
console.log(summary.join("\n"));
