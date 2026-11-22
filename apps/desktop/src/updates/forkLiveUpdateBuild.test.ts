// @effect-diagnostics nodeBuiltinImport:off - Exercise the commit range against a local Git repository.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { forkUpdateGit, listForkUpdateCommits } from "./forkLiveUpdateBuild.ts";

it("lists only the commit subjects after the installed build", async () => {
  const repo = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-commits-"));
  try {
    await forkUpdateGit(repo, ["init", "--quiet"]);
    const commit = (subject: string) =>
      forkUpdateGit(repo, [
        "-c",
        "user.name=T3 test",
        "-c",
        "user.email=t3@example.invalid",
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "--message",
        subject,
      ]);
    await commit("Installed release");
    const installed = await forkUpdateGit(repo, ["rev-parse", "HEAD"]);
    await commit("Fix terminal startup");
    await commit("Update the sidebar");
    const head = await forkUpdateGit(repo, ["rev-parse", "HEAD"]);

    expect(await listForkUpdateCommits(repo, installed, head)).toEqual([
      "Update the sidebar",
      "Fix terminal startup",
    ]);
  } finally {
    await NodeFSP.rm(repo, { force: true, recursive: true });
  }
});
