import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

const entries = NodeFS.readFileSync(process.env.INBOX_PLAN_RECORDING, "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
const inbound = entries.filter((entry) => entry.type === "emit_inbound");
const response = (label) =>
  inbound.find((entry) => entry.label === label && entry.frame.id)?.frame.result;
const thread = response("thread/start").thread;
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
let ordinal = 0;

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.200.0");
  process.exit(0);
}
for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "turn/start") {
    ordinal += 1;
    const turnId = "inbox-replay-" + process.pid + "-" + ordinal;
    const turn = { ...response("turn/start").turn, id: turnId };
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { threadId: thread.id, turn } });
    const publish = (item) => {
      const payload = { threadId: thread.id, turnId, item };
      send({ method: "item/started", params: { ...payload, startedAtMs: Date.now() } });
      send({ method: "item/completed", params: { ...payload, completedAtMs: Date.now() } });
    };
    const prompt = JSON.stringify(params.input);
    if (prompt.includes("Propose a plan.")) {
      const plan = inbound.find(
        ({ frame }) => frame.method === "item/completed" && frame.params.item.type === "plan",
      ).frame.params.item;
      const itemId = turnId + "-plan";
      send({
        method: "item/plan/delta",
        params: { threadId: thread.id, turnId, itemId, delta: plan.text },
      });
      publish({ ...plan, id: itemId });
    } else if (prompt.includes("PLEASE IMPLEMENT")) {
      const counter = process.env.INBOX_CHECK_COUNTER;
      if (counter) NodeFS.appendFileSync(counter, "started\n");
      const text = NodeChildProcess.execFileSync(process.execPath, ["--check", process.argv[1]]);
      publish({
        type: "agentMessage",
        id: turnId + "-review",
        text: "Fixture syntax check passed." + text,
        delivery: "async",
        questions: [{ title: "Accept the checked result?", options: ["Accept", "Revise"] }],
      });
    } else {
      publish({
        type: "agentMessage",
        id: turnId + "-reply",
        text: "Recorded response: " + params.input.map((item) => item.text ?? "").join(" "),
      });
    }
    send({
      method: "turn/completed",
      params: { threadId: thread.id, turn: { ...turn, status: "completed" } },
    });
    continue;
  }
  const result =
    method === "model/list"
      ? { data: [], nextCursor: null }
      : method === "account/read"
        ? { account: null, requiresOpenaiAuth: false }
        : method === "thread/resume"
          ? response("thread/start")
          : method === "thread/read"
            ? { thread }
            : (response(method) ?? {});
  send({ id, result });
}
