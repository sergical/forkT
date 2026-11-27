// @effect-diagnostics nodeBuiltinImport:off - Exercise sync markers against a local Git repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { readForkPendingUpdate, resolveForkPendingUpdatePaths } from "./forkPendingUpdate.ts";

it("enables local updates only for the running fork installation before and after its rename", () => {
  const paths = (name: string) =>
    resolveForkPendingUpdatePaths(
      {
        platform: "darwin",
        isPackaged: true,
        homeDirectory: "/Users/alice",
        resourcesPath: `/Applications/${name}.app/Contents/Resources`,
      },
      {},
    );
  for (const name of ["T3 fork", "forkT"]) {
    expect(paths(name)).toMatchObject({
      appPath: `/Applications/${name}.app`,
      stateDir: "/Users/alice/.t3-fork-lab/sync",
    });
  }
  expect(paths("T3 Code (Nightly)")).toBeNull();
});

it("shows the pending build's commit range until sync marks it installed", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-pending-"));
  const repo = NodePath.join(root, "repo");
  const stateDir = NodePath.join(root, "sync");
  const paths = {
    repo,
    stateDir,
    appPath: NodePath.join(root, "T3 fork.app"),
    installerPath: NodePath.join(root, "t3-fork-install-pending"),
  };
  try {
    await NodeFSP.mkdir(NodePath.join(stateDir, "pending"), { recursive: true });
    await NodeFSP.mkdir(repo);
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "--quiet");
    const commit = (subject: string) => {
      git(
        "-c",
        "user.name=T3 test",
        "-c",
        "user.email=t3@example.invalid",
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "--message",
        subject,
      );
      return `v0.1.12-nightly.20261121.5064+${git("rev-parse", "--short", "HEAD").trim()}\n`;
    };

    const installed = NodePath.join(stateDir, "installed");
    await NodeFSP.writeFile(installed, commit("Installed release"));
    commit("Fix terminal startup");
    const version = commit("Update the sidebar");
    await NodeFSP.writeFile(NodePath.join(stateDir, "pending", "version"), version);

    expect(await readForkPendingUpdate(paths)).toEqual({
      ready: { version: version.trim(), commits: ["Update the sidebar", "Fix terminal startup"] },
    });

    await NodeFSP.writeFile(installed, version);
    expect(await readForkPendingUpdate(paths)).toEqual({ ready: null });
  } finally {
    await NodeFSP.rm(root, { force: true, recursive: true });
  }
});
