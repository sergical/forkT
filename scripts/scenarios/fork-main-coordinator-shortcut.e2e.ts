import { expect } from "e2e";
import * as Effect from "effect/Effect";
import { T3_HOME } from "../e2e.config.ts";
import { environmentId, rpcClient, runPromise, test, WEB } from "./t3.ts";

test(
  "Reserved shortcuts open Main and Inbox before ordinary threads",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const worker = await t3.thread({
      project: await t3.project("Shortcut project"),
      title: "Project worker",
      messages: ["Prepare an example."],
    });
    const origin = app.baseUrl ?? "";
    const main = await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, origin);
        // Chromium reserves the desktop-only default. Bind the same command for the web runner.
        yield* client["server.upsertKeybinding"]({
          key: "mod+1",
          command: "thread.jump.1",
          when: "!modelPickerOpen && isWeb",
        });
        yield* client["server.upsertKeybinding"]({
          key: "mod+2",
          command: "thread.jump.2",
          when: "!modelPickerOpen && isWeb",
        });
        yield* client["server.upsertKeybinding"]({
          key: "mod+3",
          command: "thread.jump.3",
          when: "!modelPickerOpen && isWeb",
        });
        yield* client["server.upsertKeybinding"]({
          key: "mod+alt+g",
          command: "thread.jump.1",
          when: "isWeb",
        });
        return yield* client["forkCoordinator.open"]({ global: true });
      }).pipe(Effect.scoped),
    );
    const environment = await runPromise(environmentId(origin));
    await t3.open();
    await screen.getByRole("button", "Main coordinator").tap();
    const mainUrl = new RegExp(`/${environment}/${encodeURIComponent(main.threadId)}$`);
    await expect(browser).toHaveURL(mainUrl);
    await app.open(`/${environment}/${encodeURIComponent(worker.threadId)}`);
    await screen.getByRole("textbox", "Message Project worker").tap();
    await browser.keyboard.press("ControlOrMeta+1");
    await expect(browser).toHaveURL(mainUrl);

    await app.open(`/${environment}/${encodeURIComponent(worker.threadId)}`);
    await screen.getByRole("textbox", "Message Project worker").tap();
    await browser.keyboard.press("ControlOrMeta+2");
    await expect(browser).toHaveURL(/\/inbox$/);

    await app.open("/settings/general");
    await expect(screen.getByRole("dialog", "Settings")).toBeVisible();
    await browser.keyboard.press("ControlOrMeta+2");
    await expect(browser).toHaveURL(/\/inbox$/);
    await screen.getByRole("button", "Show threads").tap();
    await browser.keyboard.press("ControlOrMeta+3");
    await expect(browser).toHaveURL(
      new RegExp(`/${environment}/${encodeURIComponent(worker.threadId)}$`),
    );
    await browser.keyboard.press("ControlOrMeta+Alt+g");
    await expect(browser).toHaveURL(mainUrl);

    const projection = await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, origin);
        return yield* client["orchestration.getThreadProjection"]({
          threadId: main.threadId,
        });
      }).pipe(Effect.scoped),
    );
    expect(projection.runs).toHaveLength(0);
  },
);
