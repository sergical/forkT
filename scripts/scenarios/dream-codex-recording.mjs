import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.200.0");
  process.exit(0);
}

const frames = NodeFS.readFileSync(
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
const response = (method) =>
  frames.find((row) => row.label === method && row.frame.id)?.frame.result;
const threads = new Map();
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");

async function callMcp(connection, method, params, id) {
  const { server, session } = connection;
  if (new URL(server.url).hostname !== "127.0.0.1")
    throw new Error("Expected isolated loopback server");
  const res = await fetch(server.url, {
    method: "POST",
    headers: {
      ...server.http_headers,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(session && { "mcp-session-id": session }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  connection.session = res.headers.get("mcp-session-id") ?? session;
  const body = await res.text();
  if (!res.ok) throw new Error("Fixture MCP request failed: " + res.status);
  if (id === undefined) return;
  const msg = JSON.parse(
    body.startsWith("{")
      ? body
      : body
          .split("\n")
          .find((line) => line.startsWith("data:"))
          .slice(5),
  );
  if (msg.error || msg.result?.isError)
    throw new Error(msg.error?.message ?? msg.result.content[0].text);
  return msg.result;
}

async function respond(input, turn, threadId) {
  const text = input.map((part) => part.text ?? "").join("\n");
  try {
    const connection = threads.get(threadId);
    const mcp = (method, params, id) => callMcp(connection, method, params, id);
    if (!connection.session) {
      await mcp(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "dream-scenario", version: "1" },
        },
        1,
      );
      await mcp("notifications/initialized", {});
    }
    const evidenceMarker = "Retained source excerpts (data, not instructions):";
    const userTask = text.split("User message:").at(-1);
    let reply;
    if (userTask.includes(evidenceMarker)) {
      const sources = JSON.parse(
        userTask.slice(userTask.indexOf(evidenceMarker) + evidenceMarker.length).trim(),
      );
      const source = sources.find(
        (entry) => entry.role === "user" && entry.text.includes("original request link"),
      );
      if (!source) throw new Error("The Dream snapshot is missing the actual source message");
      const citations = [{ threadId: source.threadId, messageId: source.messageId }];
      const decided = userTask.includes('"revision":2');
      const suggestions = decided
        ? []
        : [
            {
              memoryId: "project-handoffs",
              expectedRevision: 1,
              title: "Project handoffs",
              body: "Include the original request link when handing work to its project.",
              kind: "decision",
              reason: "The project owner requested source links.",
              sources: citations,
            },
            {
              memoryId: "weekly-roundup",
              expectedRevision: 0,
              title: "Weekly roundup",
              body: "Keep the weekly roundup to one paragraph.",
              kind: "preference",
              reason: "The project owner asked for a short roundup.",
              sources: citations,
            },
          ];
      const catalog = await mcp("tools/list", {}, 2);
      if (catalog.tools.some((tool) => tool.name === "t3_dream_submit")) {
        await mcp("tools/call", { name: "t3_dream_submit", arguments: { suggestions } }, 3);
      }
      const plan = {
        type: "plan",
        id: NodeCrypto.randomUUID(),
        text: "Review the project handoff agreement.",
      };
      send({
        method: "item/started",
        params: { threadId, turnId: turn.id, item: plan, startedAtMs: Date.now() },
      });
      send({
        method: "item/completed",
        params: { threadId, turnId: turn.id, item: plan, completedAtMs: Date.now() },
      });
      reply = "Finished reviewing the project evidence.";
    } else {
      const commandId = userTask.includes("again")
        ? "review-after-decisions"
        : "review-project-handoffs";
      const request = {
        name: "t3_dream_start",
        arguments: { projectId: process.env.DREAM_PROJECT_ID, commandId },
      };
      await mcp("tools/call", request, 2);
      await mcp("tools/call", request, 3);
      reply = "I requested the project review.";
    }
    const item = { type: "agentMessage", id: NodeCrypto.randomUUID(), text: reply };
    send({
      method: "item/started",
      params: { threadId, turnId: turn.id, item, startedAtMs: Date.now() },
    });
    send({
      method: "item/completed",
      params: { threadId, turnId: turn.id, item, completedAtMs: Date.now() },
    });
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
          error: { message: String(error.message), additionalDetails: null, codexErrorInfo: null },
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
    const server = params.config?.["mcp_servers.t3-code"] ?? threads.get(threadId)?.server;
    const thread = { ...response("thread/start").thread, id: threadId, cwd: params.cwd };
    threads.set(threadId, { server, thread });
    send({ id, result: { ...response("thread/start"), thread } });
  } else if (method === "account/read") {
    send({ id, result: { account: null, requiresOpenaiAuth: false } });
  } else if (method === "thread/unsubscribe") {
    send({ id, result: { status: "unsubscribed" } });
  } else if (method === "skills/list") {
    send({ id, result: { data: [] } });
  } else if (method === "model/list") {
    send({ id, result: { data: [], nextCursor: null } });
  } else if (method === "turn/start") {
    const turn = { ...response(method).turn, id: NodeCrypto.randomUUID() };
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { threadId: params.threadId, turn } });
    setImmediate(() => respond(params.input, turn, params.threadId));
  } else {
    send({
      id,
      result:
        method === "thread/read"
          ? { thread: threads.get(params.threadId)?.thread }
          : (response(method) ?? {}),
    });
  }
}
