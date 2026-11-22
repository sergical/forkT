// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Watch sync marker changes without polling.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";

import { ForkLiveUpdateStateSchema, type ForkLiveUpdateState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import {
  launchForkPendingInstaller,
  readForkPendingUpdate,
  readForkPendingVersion,
  type ForkPendingUpdatePaths,
} from "./forkPendingUpdate.ts";

async function watchForkPendingUpdate(
  paths: ForkPendingUpdatePaths,
  signal: AbortSignal,
  onState: (state: ForkLiveUpdateState) => void,
  onError: (error: unknown) => void,
) {
  await NodeFSP.mkdir(paths.stateDir, { recursive: true });
  signal.throwIfAborted();
  let debounce: ReturnType<typeof NodeTimers.setTimeout>;
  let revision = 0;
  const refresh = () => {
    const current = ++revision;
    NodeTimers.clearTimeout(debounce);
    debounce = NodeTimers.setTimeout(() => {
      void readForkPendingUpdate(paths).then((next) => {
        if (!signal.aborted && current === revision) onState(next);
      }, onError);
    }, 150);
  };
  let pendingWatcher: NodeFS.FSWatcher | undefined;
  const watchPending = () => {
    pendingWatcher?.close();
    try {
      pendingWatcher = NodeFS.watch(
        NodePath.join(paths.stateDir, "pending"),
        { signal },
        (_event, name) => {
          if (name === null || name === "version") refresh();
        },
      ).on("error", onError);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") onError(error);
    }
  };
  NodeFS.watch(paths.stateDir, { signal }, (_event, name) => {
    if (name === null || name === "pending") watchPending();
    if (name === null || name === "pending" || name === "installed") refresh();
  }).on("error", onError);
  signal.addEventListener("abort", () => NodeTimers.clearTimeout(debounce), { once: true });
  watchPending();
  refresh();
}

/** Uses trusted desktop IPC to announce the local fork sync's pending build. */
export const installDesktopForkLiveUpdate = Effect.fn("desktop.forkLiveUpdate.install")(
  function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "darwin") return;
    const env = yield* HostProcess.Environment;
    const defaultAppPath = "/Applications/T3 fork.app";
    const appPath = env.T3_FORK_SYNC_APP_PATH ?? defaultAppPath;
    const scratchState = env.T3_FORK_SYNC_STATE_DIR;
    if (!NodePath.isAbsolute(appPath) || !appPath.endsWith(".app")) return;
    if (environment.isPackaged) {
      if (NodePath.resolve(environment.resourcesPath, "../..") !== appPath) return;
      if (appPath !== defaultAppPath && !scratchState) return;
    } else if (!scratchState || appPath === defaultAppPath) {
      return;
    }

    const home = environment.homeDirectory;
    const paths: ForkPendingUpdatePaths = {
      stateDir: scratchState ?? NodePath.join(home, ".t3-fork-lab", "sync"),
      repo: env.T3_FORK_REPO ?? NodePath.join(home, "src", "t3code-fork"),
      installerPath:
        env.T3_FORK_SYNC_INSTALLER ??
        NodePath.join(home, ".local", "bin", "t3-fork-install-pending"),
      appPath,
    };
    const ipc = yield* DesktopIpc.DesktopIpc;
    const windows = yield* ElectronWindow.ElectronWindow;
    const app = yield* ElectronApp.ElectronApp;
    let state: ForkLiveUpdateState = { ready: null };
    let restarting = false;

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
        handler: Effect.fn("desktop.forkLiveUpdate.restart")(function* (version) {
          if (restarting || version !== state.ready?.version) return false;
          restarting = true;
          const launched = yield* Effect.tryPromise({
            try: async () => {
              if ((await readForkPendingVersion(paths.stateDir)) !== version) return false;
              await launchForkPendingInstaller(paths, version);
              return true;
            },
            catch: String,
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Fork installer could not start", cause).pipe(Effect.as(false)),
            ),
          );
          if (!launched) {
            restarting = false;
            return false;
          }
          yield* app.quit;
          return true;
        }),
      }),
    );

    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const onError = (error: unknown) => {
      runFork(Effect.logWarning("Fork update watch failed", error));
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const controller = new AbortController();
        void watchForkPendingUpdate(
          paths,
          controller.signal,
          (next) => {
            if (
              state.ready?.version === next.ready?.version &&
              state.ready?.commits.join("\n") === next.ready?.commits.join("\n")
            )
              return;
            state = next;
            runFork(windows.sendAll(IpcChannels.FORK_LIVE_UPDATE_STATE_CHANNEL, next));
          },
          (error) => {
            if (!controller.signal.aborted) onError(error);
          },
        ).catch((error) => {
          if (!controller.signal.aborted) onError(error);
        });
        return controller;
      }),
      (controller) => Effect.sync(() => controller.abort()),
    );
  },
);
