// @effect-diagnostics nodeBuiltinImport:off -- Verify what the two real Git checkouts contain.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { environmentId, makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

const question = "Does the new price apply immediately or at renewal?";
const git = (cwd: string, ...args: string[]) => runPromise(run("git", args, { cwd }));

test(
  "A single Inbox answer sets pricing in both delegated repositories",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("Subscriptions");
    const origin = app.baseUrl ?? "";
    const rpc = <A, E>(
      call: (client: Effect.Success<ReturnType<typeof rpcClient>>) => Effect.Effect<A, E>,
    ) => runPromise(rpcClient(T3_HOME, origin).pipe(Effect.flatMap(call), Effect.scoped));
    const read = (threadId: ThreadId) =>
      rpc((c) => c["orchestration.getThreadProjection"]({ threadId }));
    for (const member of ["billing-api", "checkout-web"]) {
      const dir = NodePath.join(project, member);
      await NodeFSP.mkdir(dir);
      await git(dir, "init", "--quiet", "--initial-branch=main");
      await NodeFSP.writeFile(NodePath.join(dir, "pricing.txt"), "undecided\n");
      await git(dir, "add", "pricing.txt");
      await git(
        dir,
        "-c",
        "user.name=Scenario",
        "-c",
        "user.email=scenario@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Initial pricing",
      );
    }

    const instanceId = ProviderInstanceId.make("pricing-codex");
    const modelSelection = { instanceId, model: "gpt-6-luna" };
    await rpc((c) =>
      c["server.updateSettings"]({
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId,
          instance: {
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            displayName: "Recorded pricing worker",
            config: {
              binaryPath: NodeURL.fileURLToPath(
                new URL("./pricing-codex-recording.mjs", import.meta.url),
              ),
              homePath: NodePath.join(NodePath.dirname(project), "codex-home"),
            },
          },
        },
      }),
    );
    const { stdout } = await runPromise(
      makeState(T3_HOME).cli(
        [
          "thread",
          "start",
          project,
          "Review the independent enterprise price change.",
          "--title",
          "Enterprise contracts",
          "--provider",
          instanceId,
          "--model",
          modelSelection.model,
          "--wait",
          "--json",
        ],
        [2],
      ),
    );
    const independentId = ThreadId.make(JSON.parse(stdout).threadId);
    const independent = await read(independentId);
    const openQuestion = (projection: typeof independent) => {
      const request = projection.runtimeRequests.find(
        (r) => r.kind === "user_input" && r.status === "pending",
      );
      if (!request) throw new Error("No open user question in " + projection.thread.title);
      return request.id;
    };
    const independentRequest = openQuestion(independent);
    const projectId = independent.thread.projectId;
    const coordinator = await rpc((c) =>
      Effect.gen(function* () {
        yield* c["server.updateSettings"]({
          patch: {
            projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: "full-access" } },
          },
        });
        return yield* c["forkCoordinator.open"]({ global: false, projectId, modelSelection });
      }),
    );

    await t3.open(coordinator);
    const composer = screen.getByRole("textbox", /^Message /);
    await composer.fill(
      "Coordinate the subscription price change in the billing API and checkout page.",
    );
    await composer.press("Enter");
    await screen
      .getByText(/The billing decision is shared with checkout\.|Pricing task failed:/)
      .first()
      .waitFor({ timeout: 90_000 });
    const owner = await read(coordinator.threadId);
    expect(owner.subagents.map((task) => task.title).sort()).toEqual([
      "Billing service",
      "Checkout page",
    ]);
    const checkout = async (name: string, member: string) => {
      const threadId = owner.subagents.find((task) => task.title === name)?.childThreadId;
      if (!threadId)
        throw new Error(
          "The coordinator did not delegate " + name + ": " + owner.messages.at(-1)?.text,
        );
      const worker = await read(threadId);
      const { worktreePath } = worker.thread;
      if (!worktreePath) throw new Error(name + " has no worktree.");
      const { taskFolder } = await rpc((c) => c["workspace.taskFolder"]({ worktreePath }));
      const source = NodePath.join(project, member);
      expect(taskFolder?.repositories.map((r) => r.repositoryPath)).toEqual([source]);
      const assigned = taskFolder!.repositories[0]!.worktreePath;
      const { stdout } = await git(source, "worktree", "list", "--porcelain", "-z");
      const worktrees = stdout
        .split("\0")
        .filter((field) => field.startsWith("worktree "))
        .map((field) => field.slice("worktree ".length));
      expect(worktrees.sort()).toEqual(
        [await NodeFSP.realpath(source), await NodeFSP.realpath(assigned)].sort(),
      );
      return { worker, assigned, source };
    };
    const api = await checkout("Billing service", "billing-api");
    const web = await checkout("Checkout page", "checkout-web");
    await expect(
      screen.getByText("The billing decision is shared with checkout.", { exact: true }),
    ).toBeVisible();
    const request = openQuestion(api.worker);
    const environment = await runPromise(environmentId(origin));
    const threadPath = (id: ThreadId) => "/" + environment + "/" + encodeURIComponent(id);
    const href =
      threadPath(api.worker.thread.id) + "#" + new URLSearchParams({ "inbox-question": request });

    const inboxCount = (n: number) => screen.getByRole("link", "Inbox " + n, { exact: true });
    await inboxCount(2).tap();
    const queue = screen.getByRole("main", { exact: true });
    const askingWorker = queue.getByRole("link", "Billing service", { exact: true });
    const shared = browser
      .locator("form")
      .filter({ has: screen.getByRole("link", "Billing service", { exact: true }) });
    const independentOrigin = queue.getByRole("link", /Enterprise contracts/);
    await expect(
      queue.getByRole("heading", "Subscriptions · " + owner.thread.title, { exact: true }),
    ).toBeVisible();
    await expect(queue.getByText(question, { exact: true })).toHaveCount(2);
    await expect(shared.getByText(question, { exact: true })).toHaveCount(1);
    await expect(
      shared.getByText("Your answer will reach 2 workers.", { exact: true }),
    ).toBeVisible();
    const linkedPr = shared.getByRole("link", "pricing-example/billing-api#17", { exact: true });
    await expect(linkedPr).toHaveAttribute(
      "href",
      "https://github.com/pricing-example/billing-api/pull/17",
    );
    await expect(askingWorker).toHaveAttribute("href", href);
    await app.screenshot("shared-pricing-question");
    await askingWorker.tap();
    await expect(browser).toHaveURL(origin + href);
    await expect(screen.getByRole("button", /^At renewal/)).toBeVisible();
    await browser.back();
    await expect(browser).toHaveURL(origin + "/inbox");
    await shared.getByRole("radio", /^At renewal/).tap();
    await shared.getByRole("button", "Send answer").tap();
    await expect(inboxCount(1)).toBeVisible();

    for (const { worker, assigned, source } of [api, web]) {
      const member = NodePath.basename(source);
      await app.open(threadPath(worker.thread.id));
      await expect(
        screen.getByText(member + " now applies the new price: At renewal.", { exact: true }),
      ).toBeVisible();
      expect(await NodeFSP.readFile(NodePath.join(assigned, "pricing.txt"), "utf8")).toBe(
        "At renewal\n",
      );
      expect(await NodeFSP.readFile(NodePath.join(source, "pricing.txt"), "utf8")).toBe(
        "undecided\n",
      );
    }

    await inboxCount(1).tap();
    await browser.reload();
    await expect(inboxCount(1)).toBeVisible();
    await expect(askingWorker).toHaveCount(0);
    await expect(independentOrigin).toHaveAttribute(
      "href",
      threadPath(independentId) +
        "#" +
        new URLSearchParams({ "inbox-question": independentRequest }),
    );
    await expect(queue.getByText(question, { exact: true })).toHaveCount(1);
    await expect(queue.getByRole("radio", /^At renewal/)).toBeEnabled();
    expect(openQuestion(await read(independentId))).toBe(independentRequest);
    await app.screenshot("independent-pricing-question");
  },
);
