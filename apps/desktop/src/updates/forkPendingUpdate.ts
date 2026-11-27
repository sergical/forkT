// @effect-diagnostics nodeBuiltinImport:off - The updater reads sync markers and launches a macOS installer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";

import type { ForkLiveUpdateState } from "@t3tools/contracts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const syncVersion = /^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9.]+\+([0-9a-f]{4,40})$/;

export interface ForkPendingUpdatePaths {
  readonly stateDir: string;
  readonly repo: string;
  readonly appPath: string;
  readonly installerPath: string;
}

/** Limits the fork installer to the production bundle or an explicitly isolated copy. */
export function resolveForkPendingUpdatePaths(
  environment: {
    readonly platform: NodeJS.Platform;
    readonly homeDirectory: string;
    readonly resourcesPath: string;
    readonly isPackaged: boolean;
  },
  env: Readonly<NodeJS.ProcessEnv>,
): ForkPendingUpdatePaths | null {
  if (environment.platform !== "darwin") return null;
  const runningAppPath = NodePath.resolve(environment.resourcesPath, "../..");
  const appPath = env.T3_FORK_SYNC_APP_PATH ?? runningAppPath;
  const production =
    appPath === "/Applications/forkT.app" || appPath === "/Applications/T3 fork.app";
  const scratchState = env.T3_FORK_SYNC_STATE_DIR;
  if (!NodePath.isAbsolute(appPath) || !appPath.endsWith(".app")) return null;
  if (environment.isPackaged && runningAppPath !== appPath) return null;
  if (production && !environment.isPackaged) return null;
  if (!production && (!env.T3_FORK_SYNC_APP_PATH || !scratchState)) return null;
  const home = environment.homeDirectory;
  return {
    stateDir: scratchState ?? NodePath.join(home, ".t3-fork-lab", "sync"),
    repo: env.T3_FORK_REPO ?? NodePath.join(home, "src", "t3code-fork"),
    installerPath:
      env.T3_FORK_SYNC_INSTALLER ?? NodePath.join(home, ".local", "bin", "t3-fork-install-pending"),
    appPath,
  };
}

async function readSyncVersion(file: string) {
  const version = await NodeFSP.readFile(file, "utf8").catch(() => "");
  return version.trim();
}

/** Reads only complete, unapplied builds published by the sync script. */
export async function readForkPendingVersion(stateDir: string) {
  const [version, installed] = await Promise.all([
    readSyncVersion(NodePath.join(stateDir, "pending", "version")),
    readSyncVersion(NodePath.join(stateDir, "installed")),
  ]);
  return syncVersion.test(version) && version !== installed ? version : null;
}

/** Shows a pending build even when local Git history no longer contains a commit in its range. */
export async function readForkPendingUpdate(
  paths: ForkPendingUpdatePaths,
): Promise<ForkLiveUpdateState> {
  const version = await readForkPendingVersion(paths.stateDir);
  if (version === null) return { ready: null };

  const pendingCommit = version.slice(version.lastIndexOf("+") + 1);
  const installedVersion = await readSyncVersion(NodePath.join(paths.stateDir, "installed"));
  let installedCommit = syncVersion.exec(installedVersion)?.[1];
  if (!installedCommit) {
    const plist = NodePath.join(paths.appPath, "Contents", "Info.plist");
    const commit = await exec("/usr/bin/plutil", ["-extract", "T3ForkCommitHash", "raw", plist])
      .then(({ stdout }) => stdout.trim())
      .catch(() => "");
    if (/^[0-9a-f]{40}$/.test(commit)) installedCommit = commit;
  }

  const commits = await exec("git", [
    "-C",
    paths.repo,
    "log",
    "--format=%s",
    ...(installedCommit ? [`${installedCommit}..${pendingCommit}`] : ["-1", pendingCommit]),
    "--",
  ])
    .then(({ stdout }) => stdout.trimEnd().split("\n").filter(Boolean))
    .catch(() => []);
  return { ready: { version, commits } };
}

/** Hands off the requested build and coordinator route before Electron begins shutting down. */
export async function launchForkPendingInstaller(
  paths: ForkPendingUpdatePaths,
  version: string,
  route: string | undefined,
) {
  const { stdout } = await exec(paths.installerPath, ["--restart-protocol"], { timeout: 15_000 });
  if (stdout.trim() !== "1") throw new Error("Fork installer does not support verified restart");
  const log = await NodeFSP.open(NodePath.join(paths.stateDir, "restart.log"), "a");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        paths.installerPath,
        ["--restart", String(NodeProcess.pid), version, ...(route ? [route] : [])],
        {
          detached: true,
          env: {
            ...NodeProcess.env,
            T3_FORK_SYNC_STATE_DIR: paths.stateDir,
            T3_FORK_SYNC_APP_PATH: paths.appPath,
          },
          stdio: ["ignore", log.fd, log.fd],
        },
      );
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  } finally {
    await log.close();
  }
}
