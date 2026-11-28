import { CommandId, ThreadId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { environmentId, rpcClient, runPromise, test, WEB } from "./t3.ts";

test(
  "Inbox delivers a hidden worker's decision once and respects source replies",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const validationContext =
      "Decide how the API client validates search results before we ship the dashboard.";
    const first = await t3.thread({
      project: await t3.project("API client"),
      title: "Validation review",
      messages: [validationContext],
      model: "question",
    });
    const second = await t3.thread({
      project: await t3.project("Web dashboard"),
      title: "Settings form",
      messages: ["Choose whether the settings form accepts flexible input or only defined fields."],
      model: "question",
    });
    const origin = app.baseUrl ?? "";
    const firstId = ThreadId.make(first.threadId);
    const secondId = ThreadId.make(second.threadId);
    const environment = await runPromise(environmentId(origin));
    const projection = (threadId: ThreadId) =>
      runPromise(
        Effect.gen(function* () {
          const client = yield* rpcClient(T3_HOME, origin);
          return yield* client["orchestration.getThreadProjection"]({ threadId });
        }).pipe(Effect.scoped),
      );
    const before = await projection(firstId);
    const pending = before.runtimeRequests.find(
      (request) => request.kind === "user_input" && request.status === "pending",
    );
    const firstQuestion = before.turnItems.find(
      (item) => item.type === "user_input_request" && item.requestId === pending?.id,
    );
    if (!pending || firstQuestion?.type !== "user_input_request" || !firstQuestion.questions[0]) {
      throw new Error("Replay did not leave a question for the first worker.");
    }

    await browser.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await t3.open();
    const main = screen.getByRole("button", "Main coordinator");
    await main.tap();
    await expect(browser).toHaveURL(/fork%3Aglobal%3A/);
    await expect(screen.getByText("Validation review", { exact: true })).toHaveCount(0);
    await expect(screen.getByText("Settings form", { exact: true })).toHaveCount(0);

    const inbox = screen.getByRole("link", /^Inbox/);
    await expect(screen.getByRole("link", "Inbox 2", { exact: true })).toBeVisible();
    await inbox.tap();
    await expect(browser).toHaveURL(/\/inbox$/);
    const queue = screen.getByRole("main", { exact: true });
    const firstForm = browser.locator("form").filter({ hasText: "Validation review" });
    await expect(queue.getByText("API client · Validation review")).toBeVisible();
    await expect(queue.getByText(validationContext)).toBeVisible();
    await expect(queue.getByText("Web dashboard · Settings form")).toBeVisible();
    await browser.setViewport({ width: 1280, height: 310 });
    const bottomOrigin = queue.getByRole("link", / · /).last();
    const bottomHref = await bottomOrigin.getAttribute("href");
    await browser.evaluate(() => {
      document.querySelector('[data-scroll-restoration-id="fork-inbox"]')?.scrollBy(0, 110);
      return new Promise<null>((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    const scrollTop = () =>
      browser.evaluate(
        () => document.querySelector('[data-scroll-restoration-id="fork-inbox"]')?.scrollTop ?? 0,
      );
    const position = await scrollTop();
    expect(position).toBeGreaterThan(0);
    await bottomOrigin.tap();
    await expect(browser).toHaveURL(new RegExp(bottomHref + "$"));
    await expect(screen.getByRole("button", /^Strict schemas/)).toBeVisible();
    await browser.evaluate(() => {
      history.back();
      return null;
    });
    await expect(browser).toHaveURL(/\/inbox$/);
    await expect(bottomOrigin).toBeVisible();
    expect(await scrollTop()).toBe(position);
    await browser.setViewport({ width: 1280, height: 800 });
    await app.screenshot("dark-inbox-populated");
    // The agent marked "Strict schemas (Recommended)": Inbox starts with it selected.
    await expect(firstForm.getByText("Recommended", { exact: true })).toBeVisible();
    await expect(firstForm.getByRole("radio", /Strict schemas/)).toBeChecked();
    await firstForm.getByRole("button", "Send answer").tap();
    await expect(queue.getByText("Answer recorded")).toBeVisible();
    await expect(screen.getByRole("link", "Inbox 1", { exact: true })).toBeVisible();
    await expect(queue.getByText("API client · Validation review")).toHaveCount(0);
    await expect(queue.getByText("Web dashboard · Settings form")).toBeVisible();

    await app.open(`/${environment}/${encodeURIComponent(first.threadId)}`);
    await expect(screen.getByText("plan questions fixture complete", { exact: false })).toHaveCount(
      1,
    );
    await app.open("/inbox");
    await expect(queue.getByText("API client · Validation review")).toHaveCount(0);
    await expect(queue.getByText("Web dashboard · Settings form")).toBeVisible();

    const staleRetry = await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, origin);
        return yield* client["orchestration.dispatchCommand"]({
          type: "runtime-request.respond",
          commandId: CommandId.make("scenario-inbox-stale-response"),
          threadId: firstId,
          requestId: pending.id,
          answers: { [firstQuestion.questions[0]!.id]: "Strict schemas (Recommended)" },
        }).pipe(Effect.result);
      }).pipe(Effect.scoped),
    );
    expect(staleRetry._tag).toBe("Failure");
    const afterRetry = await projection(firstId);
    expect(afterRetry.runs.map((run) => run.status)).toEqual(["completed"]);
    expect(
      afterRetry.runtimeRequests
        .filter((request) => request.id === pending.id)
        .map((request) => request.status),
    ).toEqual(["resolved"]);
    expect(
      (await projection(secondId)).runtimeRequests.some(
        (request) => request.kind === "user_input" && request.status === "pending",
      ),
    ).toBe(true);

    await queue.getByRole("link", "Web dashboard · Settings form").tap();
    await expect(browser).toHaveURL(
      new RegExp(encodeURIComponent(second.threadId) + "#inbox-question="),
    );
    await expect(screen.getByRole("button", /^Strict schemas/)).toBeVisible();
    await app.screenshot("dark-inbox-origin");
    await screen.getByRole("button", /^Strict schemas/).tap();
    await expect(screen.getByText("plan questions fixture complete", { exact: false })).toHaveCount(
      1,
    );
    await app.open("/inbox");
    await expect(screen.getByRole("link", "Inbox", { exact: true })).toBeVisible();
    await expect(queue.getByText("All caught up.")).toBeVisible();
    await app.screenshot("dark-inbox-empty");
    await browser.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await browser.setViewport({ width: 390, height: 800 });
    await app.open(`/${environment}/${encodeURIComponent(second.threadId)}`);
    const sidebar = screen.getByRole("button", "Toggle main sidebar");
    await sidebar.tap();
    await screen.getByRole("link", "Inbox", { exact: true }).tap();
    await expect(browser).toHaveURL(/\/inbox$/);
    await expect(queue.getByRole("heading", "Inbox")).toBeVisible();
    await expect(sidebar).toHaveAttribute("aria-pressed", "false");
    await app.screenshot("light-inbox-narrow");
    await sidebar.tap();
    await expect(screen.getByRole("button", "Main coordinator")).toBeVisible();
  },
);
