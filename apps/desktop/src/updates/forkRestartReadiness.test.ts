// @effect-diagnostics nodeBuiltinImport:off - Exercise the installer's readiness receipt against a scratch folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { forkCoordinatorRestartRoute, forkRestartReadiness } from "./forkRestartReadiness.ts";

it("restores the initiating coordinator once and leaves an ordinary launch alone", async () => {
  const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-restart-"));
  try {
    const attempt = "restart.abcdefgh";
    const route = "/env-1/fork%3Aproject%3Aproject-1%3A1";
    const captured = forkCoordinatorRestartRoute(`t3fork://app/#${route}?panel=terminal`);
    expect(captured).toBe(route);
    expect(forkCoordinatorRestartRoute("t3fork://app/#/env-1/ordinary-thread")).toBeUndefined();
    expect(forkRestartReadiness(stateDir, [])).toBeUndefined();

    const attemptDir = NodePath.join(stateDir, attempt);
    await NodeFSP.mkdir(attemptDir);
    const restart = forkRestartReadiness(stateDir, [
      `--t3-fork-restart-attempt=${attempt}`,
      `--t3-fork-restart-route=${captured}`,
    ])!;
    expect(restart.route()).toBe(route);
    const backend = new URL("http://127.0.0.1:3773/");
    expect(await restart.markReady(backend)).toBe(true);
    expect(await NodeFSP.readFile(NodePath.join(attemptDir, "ready"), "utf8")).toBe(
      `${process.pid}\nhttp://127.0.0.1:3773/.well-known/t3/environment\n`,
    );
    expect(restart.route()).toBeUndefined();
    expect(await restart.markReady(backend)).toBe(false);
  } finally {
    await NodeFSP.rm(stateDir, { force: true, recursive: true });
  }
});
