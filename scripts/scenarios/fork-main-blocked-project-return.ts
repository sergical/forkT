// @effect-diagnostics nodeBuiltinImport:off -- The scenario provisions the isolated Codex home and warehouse files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import { CommandId, ProviderInstanceId, ThreadId, type RuntimeMode } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { T3_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

export const blockedProjectReturn = () =>
  test(
    "Main keeps the project result when its subscription runs out and retries the next message once",
    WEB,
    async ({ t3, app, browser, screen }) => {
      const project = await t3.project("Warehouse");
      const home = NodePath.join(NodePath.dirname(project), "warehouse-codex");
      await NodeFSP.mkdir(home);
      const instanceId = ProviderInstanceId.make("warehouse-codex");
      const modelSelection = { instanceId, model: "gpt-6.2-sol" };
      const resetsAt = Math.floor((await runPromise(Clock.currentTimeMillis)) / 1000) + 3600;
      const setWindow = (usedPercent: number) =>
        NodeFSP.writeFile(
          NodePath.join(home, "session-window.json"),
          JSON.stringify({
            usedPercent,
            windowDurationMins: 300,
            resetsAt,
          }),
        );
      await setWindow(5);
      const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
      const original = await NodeFSP.readFile(settingsPath, "utf8");
      const settings = JSON.parse(original);
      const scope = await Effect.runPromise(Scope.make());
      try {
        const client = await runPromise(
          rpcClient(T3_HOME, app.baseUrl ?? "").pipe(Effect.provideService(Scope.Scope, scope)),
        );
        settings.forkCoordinatorRouting = {
          excludedDrivers: [],
          excludedInstances: Object.keys(settings.providerInstances),
        };
        settings.defaultModelSelection = modelSelection;
        settings.defaultRuntimeMode = "full-access";
        settings.providerInstances[instanceId] = {
          driver: "codex",
          enabled: true,
          displayName: "Warehouse subscription",
          config: {
            binaryPath: NodeURL.fileURLToPath(
              new URL("./handoff-codex-recording.mjs", import.meta.url),
            ),
            homePath: home,
          },
        };
        await NodeFSP.writeFile(settingsPath, JSON.stringify(settings));
        await runPromise(
          client.subscribeServerConfig({}).pipe(
            Stream.filter((e) =>
              (e.type === "snapshot"
                ? e.config.providers
                : e.type === "providerStatuses"
                  ? e.payload.providers
                  : []
              ).some((p) => p.instanceId === instanceId && p.installed),
            ),
            Stream.runHead,
            Effect.timeout("60 seconds"),
          ),
        );
        const refresh = async (usedPercent: number) => {
          const { providers } = await runPromise(
            client["server.refreshProviders"]({ instanceId, fresh: true, refreshModels: true }),
          );
          const account = providers.find((p) => p.instanceId === instanceId);
          expect(account?.usageLimits?.windows.find((w) => w.id === "primary")?.usedPercent).toBe(
            usedPercent,
          );
        };
        await refresh(5);
        const read = (threadId: ThreadId) =>
          runPromise(client["orchestration.getThreadProjection"]({ threadId }));
        const main = await runPromise(client["forkCoordinator.open"]({ global: true }));
        const before = await read(main.threadId);
        const waitForRun = (ordinal: number, status: "failed" | "completed") =>
          runPromise(
            client["orchestration.subscribeThread"]({ threadId: main.threadId }).pipe(
              Stream.filter((e) =>
                (e.kind === "snapshot"
                  ? e.projection.runs
                  : e.kind === "event" && e.event.type === "run.updated"
                    ? [e.event.payload]
                    : []
                ).some((r) => r.ordinal === ordinal && r.status === status),
              ),
              Stream.runHead,
              Effect.timeout("45 seconds"),
            ),
          );
        // The release suite can reuse a Main thread that the onboarding journey already opened.
        await using previous = new AsyncDisposableStack();
        if (before.thread.modelSelection.instanceId !== instanceId) {
          const setModel = (model: typeof before.thread.modelSelection, id: string) =>
            runPromise(
              client["orchestration.dispatchCommand"]({
                type: "thread.model-selection.set",
                threadId: main.threadId,
                commandId: CommandId.make(id),
                modelSelection: model,
              }),
            );
          await setModel(modelSelection, "warehouse-select-model");
          previous.defer(async () => {
            await setModel(before.thread.modelSelection, "warehouse-restore-model");
          });
        }
        if (before.thread.runtimeMode !== "full-access") {
          const setMode = (runtimeMode: RuntimeMode, id: string) =>
            runPromise(
              client["orchestration.dispatchCommand"]({
                type: "thread.runtime-mode.set",
                threadId: main.threadId,
                commandId: CommandId.make(id),
                runtimeMode,
              }),
            );
          await setMode("full-access", "warehouse-select-mode");
          previous.defer(async () => {
            await setMode(before.thread.runtimeMode, "warehouse-restore-mode");
          });
        }
        const send = async (text: string) => {
          const composer = screen.getByRole("textbox", /^Message /);
          await composer.fill(text);
          await composer.press("Enter");
        };
        const dispatch = "Ask Warehouse to check the incoming packing list.";
        const ordinary = "Confirm that Main is available again.";
        const report = "3 parcels weigh 17 kg.";
        await t3.open("/");
        await expect(browser).toHaveURL(/fork%3Aglobal%3A/);
        await send(dispatch);
        await expect(screen.getByText(/Warehouse is checking the shipment/)).toBeVisible({
          timeout: 40_000,
        });
        const receipt = JSON.parse(
          await NodeFSP.readFile(NodePath.join(home, "dispatch.json"), "utf8"),
        );
        expect(receipt.routing?.limitingWindow?.remainingPercent).toBe(95);
        const projectThread = ThreadId.make(receipt.threadId);
        await t3.open({ threadId: projectThread });
        await expect(screen.getByText("Waiting for the packing list.")).toBeVisible();
        await setWindow(100);
        await refresh(100);
        await NodeFSP.writeFile(NodePath.join(project, "incoming"), "[4,6,7]");
        await NodeFSP.rename(
          NodePath.join(project, "incoming"),
          NodePath.join(project, "packing-list.json"),
        );
        await expect(screen.getByText(report, { exact: true })).toBeVisible();
        const sent = await read(main.threadId);
        const dispatched = sent.messages.find((m) => m.role === "user" && m.text === dispatch);
        const firstRun = sent.runs.find((r) => r.userMessageId === dispatched?.id)!;
        await waitForRun(firstRun.ordinal + 1, "failed");

        await screen.getByRole("button", "Main coordinator").tap();
        await expect(browser).toHaveURL(/fork%3Aglobal%3A/);
        await browser.reload();
        await expect(screen.getByText(dispatch, { exact: true })).toBeVisible();
        using db = new NodeSqlite.DatabaseSync(NodePath.join(T3_HOME, "userdata/statev2.sqlite"), {
          readOnly: true,
        });
        const reports = () =>
          db
            .prepare(`
          SELECT message_id, json_extract(payload_json, '$.text') AS text
          FROM orchestration_v2_projection_messages
          WHERE thread_id = ? AND json_extract(payload_json, '$.senderThreadId') = ?
        `)
            .all(main.threadId, projectThread);
        const callbacks = reports();
        expect(callbacks).toHaveLength(1);
        expect(callbacks[0]?.text).toContain(report);
        const expectBlockedStart = async (ordinal: number) => {
          const blocked = await read(main.threadId);
          const run = blocked.runs.find((r) => r.ordinal === ordinal);
          const error = blocked.turnItems.find((i) => i.type === "error" && i.runId === run?.id);
          if (error?.type !== "error") throw Error("Missing start failure for Main run " + ordinal);
          const reason = error.failure.message;
          expect(reason).toContain("Warehouse subscription");
          expect(reason).toMatch(/0%.*session/i);
          expect(reason).toMatch(/reset|wait|switch/i);
          await expect(
            screen.getByRole("region", "Conversation").getByText(reason, { exact: true }).last(),
          ).toBeVisible();
        };
        const turns = async () =>
          (await NodeFSP.readFile(NodePath.join(home, "turns.ndjson"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { prompt: string });
        try {
          await expect(screen.getByText(report, { exact: true })).toBeVisible();
        } finally {
          await app.screenshot("blocked-project-return");
        }
        await expectBlockedStart(firstRun.ordinal + 1);
        await screen
          .getByText(/Project handoff completed from/)
          .getByRole("link", /Project coordinator/)
          .tap();
        await expect(browser).toHaveURL(new RegExp(encodeURIComponent(projectThread) + "$"));
        await expect(screen.getByText(report, { exact: true })).toBeVisible();
        await screen.getByRole("button", "Main coordinator").tap();
        await expect(browser).toHaveURL(/fork%3Aglobal%3A/);
        await send(ordinary);
        await waitForRun(firstRun.ordinal + 2, "failed");
        await browser.reload();
        await expect(screen.getByText(ordinary, { exact: true })).toBeVisible();
        await expectBlockedStart(firstRun.ordinal + 2);
        expect(await turns()).toHaveLength(2);
        await app.screenshot("blocked-human-message");
        await setWindow(5);
        await refresh(5);
        await screen.getByRole("button", "Retry", { exact: true }).tap();
        await waitForRun(firstRun.ordinal + 3, "completed");
        await browser.reload();
        await expect(screen.getByText("Main is available again.", { exact: true })).toBeVisible();
        await expect(screen.getByText(report, { exact: true })).toHaveCount(1);
        const recovered = await read(main.threadId);
        expect(reports()).toEqual(callbacks);
        expect(
          recovered.runs.filter((r) => r.ordinal > firstRun.ordinal).map((r) => r.status),
        ).toEqual(["failed", "failed", "completed"]);
        expect((await read(projectThread)).runs.map((r) => [r.id, r.status])).toEqual([
          [receipt.runId, "completed"],
        ]);
        const started = await turns();
        expect(started).toHaveLength(3);
        expect(started[2]?.prompt.trim()).toBe(ordinary);
        await app.screenshot("recovered-main");
      } finally {
        await NodeFSP.writeFile(settingsPath, original);
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }
    },
  );
