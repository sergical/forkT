import { CommandId, ThreadId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { environmentId, rpcClient, runPromise, test, WEB } from "./t3.ts";

test(
  "Inbox delivers a hidden worker's decision once and respects source replies",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const first = await t3.thread({
      project: await t3.project("First project"),
      title: "First worker",
      messages: ["Ask for a preference."],
      model: "question",
    });
    const second = await t3.thread({
      project: await t3.project("Second project"),
      title: "Second worker",
      messages: ["Ask for a different project's preference."],
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

    await t3.open();
    const main = screen.getByRole("button", "Main coordinator");
    await main.tap();
    await expect(browser).toHaveURL(/fork%3Aglobal%3A/);
    const mainPath = `/${environment}/fork%3Aglobal%3A1`;
    await expect(screen.getByText("First worker", { exact: true })).toHaveCount(0);
    await expect(screen.getByText("Second worker", { exact: true })).toHaveCount(0);

    const inbox = screen.getByRole("button", "Inbox, decisions pending");
    await inbox.tap();
    const dialog = screen.getByRole("dialog", "Inbox");
    const firstForm = browser.locator("form").filter({ hasText: "First worker" });
    await expect(dialog.getByText("First project · First worker")).toBeVisible();
    await expect(dialog.getByText("Second project · Second worker")).toBeVisible();
    await app.screenshot("both-projects-waiting");
    await firstForm.getByRole("radio", /Strict schemas/).tap();
    await firstForm.getByRole("button", "Send answer").tap();
    await expect(dialog.getByText("Answer recorded")).toBeVisible();
    await expect(dialog.getByText("First project · First worker")).toHaveCount(0);
    await expect(dialog.getByText("Second project · Second worker")).toBeVisible();

    await app.open(`/${environment}/${encodeURIComponent(first.threadId)}`);
    await expect(screen.getByText("plan questions fixture complete", { exact: false })).toHaveCount(
      1,
    );
    await app.open(mainPath);
    await inbox.tap();
    await expect(dialog.getByText("First project · First worker")).toHaveCount(0);
    await expect(dialog.getByText("Second project · Second worker")).toBeVisible();

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

    await dialog.getByRole("link", "Second project · Second worker").tap();
    await expect(dialog).toBeHidden();
    await screen.getByRole("button", /^Strict schemas/).tap();
    await screen.getByRole("button", "Submit", { exact: true }).tap();
    await expect(screen.getByText("plan questions fixture complete", { exact: false })).toHaveCount(
      1,
    );
    await app.open(mainPath);
    await screen.getByRole("button", "Inbox", { exact: true }).tap();
    await expect(dialog.getByText("No decisions need your attention.")).toBeVisible();
    await app.screenshot("empty-after-source-response");
  },
);
