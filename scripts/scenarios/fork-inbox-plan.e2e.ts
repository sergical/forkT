// @effect-diagnostics nodeBuiltinImport:off -- The scenario writes a local Codex launcher.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

test(
  "Inbox sends plan decisions and review replies to their origins",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("Plan project");
    const binary = NodePath.join(project, "replay-codex");
    const fixture = NodeURL.fileURLToPath(new URL("./inbox-codex-recording.mjs", import.meta.url));
    const recording = NodePath.join(
      APP_DIR,
      "apps/server/src/orchestration-v2/testkit/fixtures/proposed_plan/codex_transcript.ndjson",
    );
    await NodeFSP.writeFile(
      binary,
      `#!/bin/sh\nINBOX_PLAN_RECORDING="${recording}" exec "${process.execPath}" "${fixture}" "$@"\n`,
    );
    await NodeFSP.chmod(binary, 0o700);
    const instanceId = ProviderInstanceId.make("inbox-codex-recording");
    await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
        yield* client["server.updateSettings"]({
          patch: {},
          providerInstanceMutation: {
            operation: "upsert",
            instanceId,
            instance: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              displayName: "Recorded Codex",
              config: { binaryPath: binary, homePath: NodePath.join(project, "codex-home") },
            },
          },
        });
      }).pipe(Effect.scoped),
    );
    const { cli } = makeState(T3_HOME);
    const workers = new Map<string, { threadId: string }>();
    for (const title of ["Implement worker", "Revise worker"]) {
      const started = await runPromise(
        cli([
          "thread",
          "start",
          project,
          "Propose a plan.",
          "--title",
          title,
          "--provider",
          instanceId,
          "--model",
          "gpt-6-luna",
          "--wait",
          "--json",
        ]),
      );
      workers.set(title, JSON.parse(started.stdout) as { threadId: string });
    }
    await t3.open();
    await screen.getByRole("link", /^Inbox/).tap();
    const queue = screen.getByRole("main", { exact: true });
    await expect(queue.getByText("Find the replay boundary.", { exact: false })).toHaveCount(2);
    await browser
      .locator("section")
      .filter({ hasText: "Plan project · Implement worker" })
      .getByRole("button", "Implement plan")
      .tap();
    await expect(queue.getByText("Fixture syntax check passed.", { exact: false })).toBeVisible();
    await queue.getByRole("radio", /Accept/).tap();
    await queue.getByRole("button", "Send answer").tap();
    await queue.getByRole("button", "Request changes").tap();
    await queue.getByRole("textbox", "Plan changes").fill("Use a smaller fixture.");
    await queue.getByRole("button", "Send changes").tap();
    await expect(queue.getByText("All caught up.")).toBeVisible();

    await t3.open(workers.get("Implement worker")!);
    await expect(
      screen.getByText("Recorded response:", { exact: false }).filter({ hasText: "Accept" }),
    ).toBeVisible();
    await t3.open(workers.get("Revise worker")!);
    await expect(
      screen
        .getByText("Recorded response:", { exact: false })
        .filter({ hasText: "Use a smaller fixture." }),
    ).toBeVisible();
  },
);
