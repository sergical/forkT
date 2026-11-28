#!/usr/bin/env node
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { callMcp } from "./recorded-codex-mcp.mjs";

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.200.0");
  process.exit(0);
}

const recording = new URL(
  "../../apps/server/src/orchestration-v2/testkit/fixtures/plan_questions/codex_transcript.ndjson",
  import.meta.url,
);
const frames = NodeFS.readFileSync(recording, "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse)
  .filter((row) => row.type === "emit_inbound");
const recorded = (label) => frames.find((row) => row.label === label).frame;
const threadStart = recorded("thread/start").result;
const turnStart = recorded("turn/start").result;
const questionTemplate = recorded("item/tool/requestUserInput");
const threads = new Map();
const requests = new Map();
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const question = "Does the new price apply immediately or at renewal?";
const options = ["Immediately", "At renewal"];
const apiTask = "Update the billing API when the effective date is decided.";
const webTask = "Update the checkout page with the agreed effective date.";

async function tool(connection, name, args) {
  if (!connection.session) {
    await callMcp(
      connection,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pricing-scenario", version: "1" },
      },
      1,
    );
    await callMcp(connection, "notifications/initialized", {});
  }
  const result = await callMcp(connection, "tools/call", { name, arguments: args }, 2);
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

function ask(threadId, turnId) {
  const id = NodeCrypto.randomUUID();
  const item = questionTemplate.params.questions[0];
  send({
    ...questionTemplate,
    id,
    params: {
      ...questionTemplate.params,
      threadId,
      turnId,
      itemId: NodeCrypto.randomUUID(),
      questions: [
        {
          ...item,
          id: "price_timing",
          header: "Price change",
          question,
          options: options.map((label) => ({ label, description: label })),
        },
      ],
    },
  });
  return new Promise((resolve) => requests.set(id, resolve));
}

function applyPrice(cwd, member, answer) {
  if (!options.includes(answer)) throw new Error("The provider did not receive a pricing answer.");
  const file = NodePath.join(cwd, member, "pricing.txt");
  const previous = NodeFS.readFileSync(file, "utf8");
  if (previous !== "undecided\n") throw new Error("Pricing was already set: " + previous);
  NodeFS.writeFileSync(file, answer + "\n");
  return member + " now applies the new price: " + answer + ".";
}

async function respond({ threadId, input, cwd }, turn) {
  const connection = threads.get(threadId);
  const task = input
    .map((part) => part.text ?? "")
    .join("\n")
    .split("User message:")
    .at(-1);
  const publish = (text) => {
    const payload = {
      threadId,
      turnId: turn.id,
      item: { type: "agentMessage", id: NodeCrypto.randomUUID(), text },
    };
    send({ method: "item/started", params: { ...payload, startedAtMs: Date.now() } });
    send({ method: "item/completed", params: { ...payload, completedAtMs: Date.now() } });
  };
  try {
    const workingDirectory = cwd ?? connection.thread.cwd;
    if (task.includes("Coordinate the subscription price change")) {
      await tool(connection, "orchestrator_capabilities", {});
      const delegate = (member, title, task) =>
        tool(connection, "delegate_task", {
          title,
          task,
          isolation: "worktree",
          repositories: [{ path: NodePath.join(workingDirectory, member) }],
          mode: "wait",
        });
      const web = await delegate("checkout-web", "Checkout page", webTask);
      const api = await delegate("billing-api", "Billing service", apiTask);
      const { requestIds } = await tool(connection, "t3_pending_request", {
        action: "list",
        threadId: api.childThreadId,
      });
      if (requestIds.length !== 1) throw new Error("Expected one open billing question.");
      await tool(connection, "t3_pending_request", {
        action: "share",
        threadId: api.childThreadId,
        requestId: requestIds[0],
        participantThreadIds: [web.childThreadId],
      });
      publish("The billing decision is shared with checkout.");
    } else if (task.includes(apiTask)) {
      await tool(connection, "link_pull_request", {
        url: "https://github.com/pricing-example/billing-api/pull/17",
      });
      const response = await ask(threadId, turn.id);
      publish(
        applyPrice(workingDirectory, "billing-api", response.answers.price_timing.answers[0]),
      );
    } else if (task.includes(webTask)) {
      publish("The checkout update is waiting for the billing decision.");
    } else if (task.includes("Review the independent enterprise price change")) {
      await ask(threadId, turn.id);
      publish("The independent enterprise decision was received.");
    } else if (task.includes(question)) {
      const answer = options.find((option) =>
        task.slice(task.lastIndexOf(question) + question.length).includes(option),
      );
      publish(applyPrice(workingDirectory, "checkout-web", answer));
    } else {
      publish("Acknowledged.");
    }
    send({
      method: "turn/completed",
      params: { threadId, turn: { ...turn, status: "completed" } },
    });
  } catch (error) {
    publish("Pricing task failed: " + error.message);
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          ...turn,
          status: "failed",
          error: { message: error.message, additionalDetails: null, codexErrorInfo: null },
        },
      },
    });
  }
}

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  if (id === undefined) continue;
  if (!method) {
    requests.get(id)?.(result);
    requests.delete(id);
  } else if (method === "thread/start" || method === "thread/resume") {
    const nativeId = params.threadId ?? NodeCrypto.randomUUID();
    const known = threads.get(nativeId);
    const thread = { ...threadStart.thread, id: nativeId, cwd: params.cwd ?? known?.thread.cwd };
    threads.set(nativeId, {
      thread,
      server: params.config?.["mcp_servers.t3-code"] ?? known?.server,
    });
    send({ id, result: { ...threadStart, thread } });
  } else if (method === "turn/start") {
    const turn = { ...turnStart.turn, id: NodeCrypto.randomUUID() };
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { threadId: params.threadId, turn } });
    void respond(params, turn);
  } else {
    const replies = {
      "account/read": { account: null, requiresOpenaiAuth: false },
      "model/list": { data: [], nextCursor: null },
      "skills/list": { data: [] },
      "thread/read": { thread: threads.get(params?.threadId)?.thread },
      "thread/unsubscribe": { status: "unsubscribed" },
    };
    send({
      id,
      result: replies[method] ?? frames.find((row) => row.label === method)?.frame.result ?? {},
    });
  }
}
