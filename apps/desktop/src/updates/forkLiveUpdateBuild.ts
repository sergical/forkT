// @effect-diagnostics nodeBuiltinImport:off - The local builder owns Git and macOS child processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const COMMIT_HASH = /^[0-9a-f]{40}$/;

export interface ForkLiveUpdateBuildConfig {
  readonly repo: string;
  readonly branch: string;
  readonly installPath: string;
  readonly logDir: string;
  readonly signed: boolean;
}

export async function forkUpdateGit(repo: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repo, ...args], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

export async function readForkInstalledCommit(installPath: string): Promise<string | null> {
  try {
    if (!(await NodeFSP.lstat(installPath)).isDirectory()) {
      throw new Error("Fork update install target must be an app bundle directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const { stdout } = await exec("/usr/bin/plutil", [
    "-extract",
    "T3ForkCommitHash",
    "raw",
    NodePath.join(installPath, "Contents", "Info.plist"),
  ]);
  const sha = stdout.trim();
  if (!COMMIT_HASH.test(sha)) throw new Error("Fork update bundle has an invalid commit hash.");
  return sha;
}

export async function listForkUpdateCommits(repo: string, installed: string | null, head: string) {
  const format = "--format=%s";
  const subjects = await forkUpdateGit(
    repo,
    installed === null ? ["show", "-s", format, head] : ["log", format, `${installed}..${head}`],
  );
  return subjects === "" ? [] : subjects.split("\n");
}

async function findMacAppBundle(directory: string): Promise<string> {
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith(".app")) return NodePath.join(directory, entry.name);
    if (entry.name.startsWith("mac")) return findMacAppBundle(NodePath.join(directory, entry.name));
  }
  throw new Error("Fork update build did not produce a macOS app bundle.");
}

export async function forkUpdateLogTail(logPath: string): Promise<string> {
  const file = await NodeFSP.open(logPath, NodeFS.constants.O_RDONLY);
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    await file.read(buffer, 0, buffer.length, size - buffer.length);
    return NodeUtil.stripVTControlCharacters(buffer.toString())
      .split(/\r?\n/)
      .filter((line) => line.trim() && !/^\s+at /.test(line))
      .slice(-10)
      .join("\n");
  } finally {
    await file.close();
  }
}

async function runBuildCommand(
  cwd: string,
  args: readonly string[],
  logPath: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const log = await NodeFSP.open(logPath, "a");
  try {
    await log.write(`\n$ vp ${args.join(" ")}\n`);
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.spawn("vp", args, {
        cwd,
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
      });
      // Signal only the process group that belongs to this build.
      const stop = () => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // The process group may have already exited.
          }
        }
      };
      signal.addEventListener("abort", stop, { once: true });
      child.once("error", reject);
      child.once("close", (code, terminationSignal) => {
        signal.removeEventListener("abort", stop);
        if (code === 0) resolve();
        else reject(new Error(`Fork update command exited with ${code ?? terminationSignal}.`));
      });
    });
  } finally {
    await log.close();
  }
}

async function installForkBundle(source: string, target: string, hadPreviousBundle: boolean) {
  if (!hadPreviousBundle) {
    await NodeFSP.rename(source, target);
    return;
  }

  const { DataType, load, open: openLibrary, close } = await import("ffi-rs");
  const library = "t3-fork-live-update";
  openLibrary({ library, path: "/usr/lib/libSystem.B.dylib" });
  try {
    // RENAME_SWAP exchanges both paths in one filesystem operation.
    const result = load({
      library,
      funcName: "renamex_np",
      retType: DataType.I32,
      paramsType: [DataType.String, DataType.String, DataType.U32],
      paramsValue: [source, target, 2],
    });
    if (result !== 0) throw new Error("Fork update could not atomically exchange the app bundles.");
  } finally {
    close(library);
  }
}

export async function buildAndInstallForkUpdate(input: {
  readonly config: ForkLiveUpdateBuildConfig;
  readonly head: string;
  readonly installed: string | null;
  readonly restartBase: string | null;
  readonly logPath: string;
  readonly signal: AbortSignal;
}) {
  const { config, head, installed, restartBase, logPath, signal } = input;
  await NodeFSP.mkdir(config.logDir, { recursive: true });
  const work = await NodeFSP.mkdtemp(
    NodePath.join(NodePath.dirname(config.repo), ".t3-fork-build-"),
  );
  let staging: string | undefined;
  const checkout = NodePath.join(work, "checkout");
  try {
    await forkUpdateGit(config.repo, ["worktree", "add", "--detach", checkout, head]);
    for (const file of [".env", ".env.local"]) {
      const source = NodePath.join(config.repo, file);
      const exists = await NodeFSP.lstat(source).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (exists) await NodeFSP.symlink(source, NodePath.join(checkout, file));
    }
    await runBuildCommand(checkout, ["i", "--frozen-lockfile"], logPath, signal);
    staging = await NodeFSP.mkdtemp(
      NodePath.join(NodePath.dirname(config.installPath), ".t3-fork-install-"),
    );
    await runBuildCommand(
      checkout,
      [
        "run",
        "dist:desktop:artifact",
        "--platform",
        "mac",
        "--target",
        "dir",
        "--output-dir",
        staging,
        ...(config.signed ? ["--signed"] : ["--no-signed"]),
      ],
      logPath,
      signal,
    );

    const bundle = await findMacAppBundle(staging);
    if ((await readForkInstalledCommit(bundle)) !== head) {
      throw new Error("Fork update bundle does not match the requested commit.");
    }
    const commits = await listForkUpdateCommits(config.repo, restartBase, head);
    if ((await readForkInstalledCommit(config.installPath)) !== installed) {
      throw new Error("Fork update install target changed during the build.");
    }
    if (head !== (await readForkBranchHead(config))) return null;
    signal.throwIfAborted();
    await installForkBundle(bundle, config.installPath, installed !== null);
    return commits;
  } finally {
    // Cleanup after the swap cannot turn a successful install into a build failure.
    await forkUpdateGit(config.repo, ["worktree", "remove", "--force", checkout]).catch(() => {});
    await NodeFSP.rm(work, { recursive: true, force: true }).catch(() => {});
    if (staging !== undefined)
      await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export function readForkBranchHead(config: Pick<ForkLiveUpdateBuildConfig, "repo" | "branch">) {
  return forkUpdateGit(config.repo, [
    "rev-parse",
    "--verify",
    `refs/heads/${config.branch}^{commit}`,
  ]);
}
