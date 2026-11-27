// @effect-diagnostics nodeBuiltinImport:off -- The isolated Codex peer uses the native process protocol.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { CommandId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

test(
  "A requested Dream returns to its chat for an optional, source-backed decision",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("Release notes");
    const source = await t3.thread({
      project,
      title: "Handoff agreement",
      messages: [
        "For cross-team handoffs, include the original request link. Keep the weekly roundup to one paragraph.",
      ],
    });
    const origin = app.baseUrl ?? "";
    const instanceId = ProviderInstanceId.make("dream-recording");
    const modelSelection = { instanceId, model: "gpt-6-luna" };
    const setup = await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, origin);
        const projection = yield* client["orchestration.getThreadProjection"]({
          threadId: ThreadId.make(source.threadId),
        });
        const evidence = projection.messages.find((m) => m.role === "user");
        if (!evidence) throw new Error("The source conversation has no user message.");
        const projectId = projection.thread.projectId;
        yield* client["forkMemory.save"]({
          commandId: CommandId.make("seed-old-handoff"),
          projectId,
          id: "project-handoffs",
          expectedRevision: 0,
          kind: "decision",
          title: "Project handoffs",
          body: "Send work to the responsible project.",
          reason: "Existing agreement.",
          sources: [{ threadId: projection.thread.id, messageId: evidence.id }],
        });
        return { projectId, evidence };
      }).pipe(Effect.scoped),
    );
    const peer = NodeURL.fileURLToPath(new URL("./dream-codex-recording.mjs", import.meta.url));
    const binary = NodePath.join(project, "dream-codex");
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    await NodeFSP.writeFile(
      binary,
      `#!/bin/sh\nexport DREAM_PROJECT_ID=${quote(setup.projectId)}\nexec ${quote(process.execPath)} ${quote(peer)} "$@"\n`,
      { mode: 0o700 },
    );
    const requester = await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, origin);
        yield* client["server.updateSettings"]({
          patch: {
            projectSettingsOverrides: { [setup.projectId]: { defaultRuntimeMode: "full-access" } },
          },
          providerInstanceMutation: {
            operation: "upsert",
            instanceId,
            instance: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              displayName: "Recorded review",
              config: { binaryPath: binary, homePath: NodePath.join(project, "codex-home") },
            },
          },
        });
        return yield* client["forkCoordinator.open"]({
          global: false,
          projectId: setup.projectId,
          modelSelection,
        });
      }).pipe(Effect.scoped),
    );

    await t3.open(requester);
    const requestReview = async (text: string) => {
      const composer = screen.getByRole("textbox", /^Message /);
      await composer.fill(text);
      await composer.press("Enter");
    };
    await requestReview("Please run a Dream review of our project handoffs.");
    const receipt = screen.getByRole("link", "Review 2 suggestions", { exact: true });
    await expect(receipt).toHaveCount(1);
    const reviewHref = await receipt.getAttribute("href");
    if (!reviewHref) throw new Error("The review receipt has no destination.");
    await receipt.tap();
    const review = screen.getByRole("dialog", "Dream review");
    const update = review.getByRole("region", "Project handoffs");
    const addition = review.getByRole("region", "Weekly roundup");
    await expect(update.getByText("Send work to the responsible project.")).toBeVisible();
    await expect(
      update.getByText("Include the original request link when handing work to its project."),
    ).toBeVisible();
    await update.getByRole("link", "Open source message").tap();
    await expect(browser).toHaveURL(
      new RegExp(
        encodeURIComponent(source.threadId) + ".*" + encodeURIComponent(setup.evidence.id),
      ),
    );
    await expect(
      screen
        .getByText("For cross-team handoffs, include the original request link.", { exact: false })
        .first(),
    ).toBeVisible();
    await screen.getByRole("link", "Back to Dream review").tap();
    await update.getByRole("button", "Save", { exact: true }).tap();
    await addition.getByRole("button", "Keep as is").tap();
    await app.open(reviewHref);
    await expect(update.getByText("Saved", { exact: true })).toBeVisible();
    await expect(addition.getByText("Kept as is", { exact: true })).toBeVisible();
    await app.screenshot("dream-decisions");

    await t3.open(requester);
    await requestReview("Review the project again now that the changes are settled.");
    await expect(
      screen.getByText("Reviewed. No changes recommended.", { exact: true }),
    ).toBeVisible();
    await expect(receipt).toHaveCount(1);
    await t3.open("/inbox");
    await expect(screen.getByText("All caught up.")).toBeVisible();
    const history = await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, origin);
        return yield* client["forkMemory.history"]({
          projectId: setup.projectId,
          id: "project-handoffs",
        });
      }).pipe(Effect.scoped),
    );
    expect(history.map((m) => m.revision)).toEqual([2, 1]);
  },
);
