import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import { prepareHome } from "./start-app.ts";
import { makeState, rpcClient, runPromise } from "./t3.ts";

const checkout = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-inbox-verification-"));
const model = { instanceId: "inbox-cold-recorded", model: "gpt-6-luna" };
const checks = NodePath.join(home, "syntax-checks");
let server;
let exit;
let origin;

async function prepare() {
  await runPromise(prepareHome(home));
  const provider = NodePath.join(home, "recorded-provider");
  const fixture = NodeURL.fileURLToPath(new URL("./inbox-codex-recording.mjs", import.meta.url));
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const transcript = NodePath.join(
    checkout,
    "apps/server/src/orchestration-v2/testkit/fixtures/proposed_plan/codex_transcript.ndjson",
  );
  await NodeFSP.writeFile(
    provider,
    "#!/bin/sh\nINBOX_PLAN_RECORDING=" +
      quote(transcript) +
      " INBOX_CHECK_COUNTER=" +
      quote(checks) +
      " exec " +
      quote(process.execPath) +
      " " +
      quote(fixture) +
      ' "$@"\n',
    { mode: 0o700 },
  );
  const settingsFile = NodePath.join(home, "userdata/settings.json");
  const settings = JSON.parse(await NodeFSP.readFile(settingsFile, "utf8"));
  settings.providerInstances[model.instanceId] = {
    driver: "codex",
    enabled: true,
    config: { binaryPath: provider, homePath: NodePath.join(home, "codex-home") },
  };
  settings.defaultModelSelection = model;
  await NodeFSP.writeFile(settingsFile, JSON.stringify(settings));

  const listener = NodeNet.createServer().listen(0, "127.0.0.1");
  await NodeEvents.once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function start(port) {
  origin = "http://127.0.0.1:" + port;
  const log = await NodeFSP.open(NodePath.join(home, "server.log"), "a", 0o600);
  try {
    server = NodeChildProcess.spawn(
      process.execPath,
      [
        "apps/server/src/bin.ts",
        "serve",
        "--base-dir",
        home,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--no-browser",
      ],
      {
        cwd: checkout,
        env: { ...process.env, T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0" },
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    exit = NodeEvents.once(server, "exit");
  } finally {
    await log.close();
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    NodeAssert.equal(server.exitCode, null, "Test server exited during startup");
    const ready = await fetch(origin + "/.well-known/t3/environment", {
      signal: AbortSignal.timeout(1200),
    })
      .then((r) => r.ok)
      .catch(() => false);
    if (ready) return server.pid;
    await NodeTimersPromises.setTimeout(250);
  }
  throw Error("The test server never became ready");
}

async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill("SIGTERM");
  const timer = setTimeout(() => server.kill("SIGKILL"), 15_000);
  try {
    await exit;
  } finally {
    clearTimeout(timer);
  }
}

const rpc = (call) =>
  runPromise(
    Effect.gen(function* () {
      return yield* call(yield* rpcClient(home, origin));
    }).pipe(Effect.scoped),
  );
const read = (threadId) =>
  rpc((client) => client["orchestration.getThreadProjection"]({ threadId }));
const send = (command) => rpc((client) => client["orchestration.dispatchCommand"](command));
const retry = (command) =>
  rpc((client) => client["orchestration.dispatchCommand"](command).pipe(Effect.result));
const activePlan = (p) =>
  p.plans.find((plan) => plan.kind === "proposed_plan" && plan.status === "active");
const pendingReview = (p) =>
  p.runtimeRequests.find((r) => r.kind === "user_input" && r.status === "pending");

async function until(threadId, predicate) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const projection = await read(threadId);
    if (predicate(projection)) return projection;
    await NodeTimersPromises.setTimeout(250);
  }
  throw Error("The expected worker state did not arrive");
}

try {
  const port = await prepare();
  const oldPid = await start(port);
  const { state, cli } = makeState(home);
  const workers = [];
  for (const name of ["First", "Second"]) {
    const project = await state.project(name + " project");
    const { stdout } = await runPromise(
      cli([
        "thread",
        "start",
        project,
        "Propose a plan.",
        "--provider",
        model.instanceId,
        "--model",
        model.model,
        "--title",
        name + " worker",
        "--wait",
        "--json",
      ]),
    );
    workers.push(JSON.parse(stdout).threadId);
  }
  const [first, second] = workers;
  const firstPlan = activePlan(await read(first));
  const secondPlan = activePlan(await read(second));
  NodeAssert.ok(firstPlan && secondPlan);
  const implementation = {
    type: "message.dispatch",
    commandId: NodeCrypto.randomUUID(),
    createdBy: "user",
    creationSource: "web",
    threadId: first,
    messageId: NodeCrypto.randomUUID(),
    text: "PLEASE IMPLEMENT this recorded plan.",
    attachments: [],
    modelSelection: model,
    sourcePlanRef: { threadId: first, planId: firstPlan.id },
    dispatchMode: { type: "start_immediately" },
  };
  await send(implementation); // Discard the acknowledgment, then retry after the restart.
  const review = pendingReview(await until(first, pendingReview));
  await stop();
  const newPid = await start(port);
  NodeAssert.notEqual(oldPid, newPid);
  NodeAssert.equal(pendingReview(await read(first))?.id, review.id);
  NodeAssert.equal(activePlan(await read(second))?.id, secondPlan.id);
  NodeAssert.equal((await retry(implementation))._tag, "Success");
  NodeAssert.equal(
    (
      await retry({
        ...implementation,
        commandId: NodeCrypto.randomUUID(),
        messageId: NodeCrypto.randomUUID(),
      })
    )._tag,
    "Failure",
  );
  const question = (await read(first)).turnItems.find(
    (i) => i.type === "user_input_request" && i.requestId === review.id,
  );
  NodeAssert.ok(question?.questions[0]?.id);
  await send({
    type: "runtime-request.respond",
    threadId: first,
    requestId: review.id,
    commandId: NodeCrypto.randomUUID(),
    answers: { [question.questions[0].id]: "Accept" },
  });
  const finished = await until(
    first,
    (p) => p.runs.length === 3 && p.runs.every((r) => r.status === "completed"),
  );
  NodeAssert.equal(finished.runtimeRequests.find((r) => r.id === review.id)?.status, "resolved");
  const other = await read(second);
  NodeAssert.equal(activePlan(other)?.id, secondPlan.id);
  NodeAssert.equal(other.runs.length, 1);
  NodeAssert.equal(await NodeFSP.readFile(checks, "utf8"), "started\n");
  console.log(
    "Passed: 2 server processes, 1 syntax check, 1 recovered review answered, and the other project still waiting.",
  );
} finally {
  await stop();
  await NodeFSP.rm(home, { recursive: true, force: true });
}
