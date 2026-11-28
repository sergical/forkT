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

const home = process.env.CODEX_HOME;
const transcript = NodeFS.readFileSync(
  new URL(
    "../../apps/server/src/orchestration-v2/testkit/fixtures/proposed_plan/codex_transcript.ndjson",
    import.meta.url,
  ),
  "utf8",
)
  .trim()
  .split("\n")
  .map(JSON.parse)
  .filter((row) => row.type === "emit_inbound");
const recorded = (method) =>
  transcript.find((row) => row.label === method && row.frame.id)?.frame.result;
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const threads = new Map();
const model = "gpt-6.2-sol";

async function manifest(cwd) {
  const name = "packing-list.json";
  const file = NodePath.join(cwd, name);
  // The shipment arrives atomically after the scenario observes exhaustion in the server.
  if (!NodeFS.existsSync(file)) {
    await new Promise((resolve, reject) => {
      const watcher = NodeFS.watch(cwd, (_event, changed) => {
        if (changed === name) received();
      }).on("error", reject);
      function received() {
        watcher.close();
        resolve();
      }
      if (NodeFS.existsSync(file)) received();
    });
  }
  const weights = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  return weights.length + " parcels weigh " + weights.reduce((sum, kg) => sum + kg, 0) + " kg.";
}

async function reply(params, turn) {
  const { threadId } = params;
  const connection = threads.get(threadId);
  const prompt = params.input
    .map((part) => part.text ?? "")
    .join("\n")
    .split("User message:")
    .at(-1);
  const publish = (text, phase = "final_answer") => {
    const event = {
      threadId,
      turnId: turn.id,
      item: { type: "agentMessage", id: NodeCrypto.randomUUID(), text, phase },
    };
    send({ method: "item/started", params: { ...event, startedAtMs: Date.now() } });
    send({ method: "item/completed", params: { ...event, completedAtMs: Date.now() } });
  };
  try {
    NodeFS.appendFileSync(
      NodePath.join(home, "turns.ndjson"),
      JSON.stringify({ threadId, turnId: turn.id, prompt }) + "\n",
    );
    if (prompt.trim() === "Ask Warehouse to check the incoming packing list.") {
      await callMcp(
        connection,
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "warehouse", version: "1" },
        },
        1,
      );
      await callMcp(connection, "notifications/initialized", {});
      const tool = async (name, args, id) => {
        const result = await callMcp(connection, "tools/call", { name, arguments: args }, id);
        return result.structuredContent ?? JSON.parse(result.content[0].text);
      };
      const { projects } = await tool("t3_project_list", {}, 2);
      const project = projects.find((p) => p.title === "Warehouse");
      if (!project) throw Error("Warehouse is missing from Main's list of projects.");
      const receipt = await tool(
        "t3_coordinator_open",
        {
          global: false,
          handoff: {
            projectId: project.id,
            source: "Weigh the parcels in the incoming packing list.",
            requestId: "packing-list",
          },
        },
        3,
      );
      NodeFS.writeFileSync(NodePath.join(home, "dispatch.json"), JSON.stringify(receipt));
      publish(
        "Warehouse is checking the shipment. " +
          receipt.link.replace("Project coordinator", "Warehouse dispatch"),
      );
    } else if (prompt.includes("Weigh the parcels in the incoming packing list.")) {
      publish("Waiting for the packing list.", "commentary");
      publish(await manifest(params.cwd ?? connection.thread.cwd));
    } else if (prompt.trim() === "Confirm that Main is available again.") {
      publish("Main is available again.");
    } else if (prompt.trim().startsWith("Record shipment reference ")) {
      publish("Recorded " + prompt.trim().slice("Record shipment reference ".length));
    } else {
      throw Error("Unexpected provider turn: " + prompt.slice(-250));
    }
    send({
      method: "turn/completed",
      params: { threadId, turn: { ...turn, status: "completed" } },
    });
  } catch (error) {
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
  const { id, method, params } = JSON.parse(line);
  if (id === undefined || !method) continue;
  if (method === "thread/start" || method === "thread/resume") {
    const threadId = params.threadId ?? NodeCrypto.randomUUID();
    const template = recorded("thread/start");
    const thread = {
      ...template.thread,
      id: threadId,
      cwd: params.cwd ?? threads.get(threadId)?.thread.cwd,
    };
    threads.set(threadId, {
      thread,
      server: params.config?.["mcp_servers.t3-code"] ?? threads.get(threadId)?.server,
    });
    send({ id, result: { ...template, thread } });
  } else if (method === "turn/start") {
    const turn = { ...recorded(method).turn, id: NodeCrypto.randomUUID() };
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { threadId: params.threadId, turn } });
    void reply(params, turn);
  } else if (method === "account/rateLimits/read") {
    const primary = JSON.parse(
      NodeFS.readFileSync(NodePath.join(home, "session-window.json"), "utf8"),
    );
    send({
      id,
      result: {
        rateLimits: { limitId: "codex", planType: "pro", primary },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
        accountId: null,
      },
    });
  } else {
    const responses = {
      "account/read": {
        account: { type: "chatgpt", email: "warehouse@example.invalid", planType: "pro" },
        requiresOpenaiAuth: true,
      },
      "config/read": { config: {}, origins: {} },
      "model/list": {
        data: [
          {
            id: model,
            model,
            displayName: model,
            description: model,
            hidden: false,
            isDefault: true,
            serviceTiers: [],
            additionalSpeedTiers: [],
            inputModalities: ["text"],
            supportsPersonality: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
          },
        ],
        nextCursor: null,
      },
      "skills/list": { data: [] },
      "thread/read": { thread: threads.get(params?.threadId)?.thread },
      "thread/unsubscribe": { status: "unsubscribed" },
    };
    send({ id, result: responses[method] ?? recorded(method) ?? {} });
  }
}
