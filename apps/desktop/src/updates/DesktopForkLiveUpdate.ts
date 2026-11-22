// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - fs.watch delivers local Git ref changes without polling.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeTimers from "node:timers";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ForkLiveUpdateStateSchema, type ForkLiveUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../app/DesktopLifecycle.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import {
  buildAndInstallForkUpdate,
  forkUpdateGit,
  forkUpdateLogTail,
  readForkBranchHead,
  readForkInstalledCommit,
  type ForkLiveUpdateBuildConfig,
} from "./forkLiveUpdateBuild.ts";
import { createForkLiveUpdateQueue } from "./forkLiveUpdateQueue.ts";

const ForkLiveUpdateConfig = Schema.fromJsonString(
  Schema.Struct({
    repo: Schema.optional(Schema.String),
    branch: Schema.optional(Schema.String),
    installPath: Schema.optional(Schema.String),
    signed: Schema.optional(Schema.Boolean),
  }),
);

async function watchForkBranch(
  config: ForkLiveUpdateBuildConfig,
  signal: AbortSignal,
  onState: (state: ForkLiveUpdateState) => void,
) {
  let state: ForkLiveUpdateState = { ready: null, failure: null };
  let logPath = NodePath.join(config.logDir, "watcher.log");
  const reportFailure = async (error: unknown) => {
    if (signal.aborted) return;
    const failedLogPath = logPath;
    const message = String(error);
    await NodeFSP.mkdir(config.logDir, { recursive: true })
      .then(() => NodeFSP.appendFile(failedLogPath, `\n${message}\n`))
      .catch(() => {});
    state = {
      ...state,
      failure: {
        logPath: failedLogPath,
        tail: await forkUpdateLogTail(failedLogPath).catch(() => message),
      },
    };
    onState(state);
  };

  const update = createForkLiveUpdateQueue({
    readHead: () => readForkBranchHead(config),
    readInstalled: () => readForkInstalledCommit(config.installPath),
    build: (head, installed, restartBase) => {
      logPath = NodePath.join(config.logDir, `${head}-${NodeCrypto.randomUUID()}.log`);
      return buildAndInstallForkUpdate({ config, head, installed, restartBase, logPath, signal });
    },
    onReady: (sha, commits) => {
      state = { ready: { sha, commits }, failure: null };
      onState(state);
    },
    onFailure: reportFailure,
    signal,
  });
  try {
    await forkUpdateGit(config.repo, ["check-ref-format", `refs/heads/${config.branch}`]);
    const gitDir = await forkUpdateGit(config.repo, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    signal.throwIfAborted();
    let debounce: ReturnType<typeof NodeTimers.setTimeout> | undefined;
    const requestUpdate = () => {
      NodeTimers.clearTimeout(debounce);
      debounce = NodeTimers.setTimeout(() => void update(), 300);
    };
    NodeFS.watch(NodePath.join(gitDir, "refs"), { recursive: true, signal }, (_event, filename) => {
      if (
        filename === null ||
        filename === `heads/${config.branch}` ||
        filename === `heads/${config.branch}.lock`
      ) {
        requestUpdate();
      }
    }).on("error", reportFailure);
    NodeFS.watch(gitDir, { signal }, (_event, filename) => {
      if (filename === null || filename === "packed-refs") requestUpdate();
    }).on("error", reportFailure);
    signal.addEventListener("abort", () => NodeTimers.clearTimeout(debounce), { once: true });
    void update();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    await update();
  } catch (error) {
    await reportFailure(error);
  }
}

/** Installs the fork updater only in the desktop process, with trusted renderer IPC. */
export const installDesktopForkLiveUpdate = Effect.fn("desktop.forkLiveUpdate.install")(
  function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "darwin") return;
    const ipc = yield* DesktopIpc.DesktopIpc;
    const windows = yield* ElectronWindow.ElectronWindow;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const fs = yield* FileSystem.FileSystem;
    let state: ForkLiveUpdateState = { ready: null, failure: null };
    let config: ForkLiveUpdateBuildConfig | undefined;

    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: IpcChannels.FORK_LIVE_UPDATE_GET_STATE_CHANNEL,
        payload: Schema.Void,
        result: ForkLiveUpdateStateSchema,
        handler: () => Effect.sync(() => state),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: IpcChannels.FORK_LIVE_UPDATE_RESTART_CHANNEL,
        payload: Schema.String,
        result: Schema.Boolean,
        handler: Effect.fn("desktop.forkLiveUpdate.restart")(function* (sha) {
          const installPath = config?.installPath;
          if (installPath === undefined || sha !== state.ready?.sha) return false;
          const installed = yield* Effect.promise(() =>
            readForkInstalledCommit(installPath).catch(() => null),
          );
          if (installed !== sha || state.ready?.sha !== sha) return false;
          yield* lifecycle.relaunch("fork live update");
          return true;
        }),
      }),
    );

    const configPath = NodePath.join(environment.baseDir, "fork-live-update.json");
    const logDir = NodePath.join(environment.logDir, "fork-live-update");
    const exists = yield* fs.exists(configPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return;
    const options = yield* fs.readFileString(configPath).pipe(
      Effect.flatMap(Schema.decodeEffect(ForkLiveUpdateConfig)),
      Effect.catch((error) =>
        Effect.sync(() => {
          state = { ready: null, failure: { logPath: configPath, tail: String(error) } };
          return null;
        }),
      ),
    );
    if (options === null) return;
    const installPath = options.installPath ?? "/Applications/T3 fork.app";
    const repo = options.repo ?? NodePath.join(environment.homeDirectory, "src", "t3code-fork");
    // A dev app can exercise the updater only with an explicit scratch target.
    if (!environment.isPackaged && installPath === "/Applications/T3 fork.app") return;
    if (
      !NodePath.isAbsolute(installPath) ||
      !installPath.endsWith(".app") ||
      !NodePath.isAbsolute(repo)
    ) {
      state = {
        ready: null,
        failure: {
          logPath: configPath,
          tail: "Fork update requires absolute repo and .app paths.",
        },
      };
      return;
    }
    if (
      environment.isPackaged &&
      NodePath.resolve(environment.resourcesPath, "../..") !== NodePath.resolve(installPath)
    ) {
      state = {
        ready: null,
        failure: {
          logPath: configPath,
          tail: "Fork update install path must match the running app bundle.",
        },
      };
      return;
    }
    config = {
      repo,
      installPath,
      logDir,
      branch: options.branch ?? "t3-fork",
      signed: options.signed ?? true,
    };
    const activeConfig = config;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const controller = new AbortController();
        const done = watchForkBranch(activeConfig, controller.signal, (next) => {
          state = next;
          runFork(windows.sendAll(IpcChannels.FORK_LIVE_UPDATE_STATE_CHANNEL, next));
        });
        return { controller, done };
      }),
      ({ controller, done }) =>
        Effect.promise(() => {
          controller.abort();
          return done;
        }),
    );
  },
);
