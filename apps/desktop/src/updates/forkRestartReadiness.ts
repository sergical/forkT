// @effect-diagnostics nodeBuiltinImport:off - The external installer consumes a file written by the desktop.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { isForkCoordinatorThreadId } from "@t3tools/contracts";

const attemptFlag = "--t3-fork-restart-attempt=";
const routeFlag = "--t3-fork-restart-route=";

function coordinatorRoute(route: string) {
  const match = /^(\/[\w%.-]+\/([\w%:.-]+))(?:[?#].*)?$/.exec(route);
  if (!match?.[1] || !match[2]) return undefined;
  try {
    return isForkCoordinatorThreadId(decodeURIComponent(match[2])) ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

/** Captures the coordinator from Electron's hash route, without its transient search state. */
export function forkCoordinatorRestartRoute(windowUrl: string) {
  return coordinatorRoute(windowUrl.slice(windowUrl.indexOf("#/") + 1));
}

/** Creates a one-shot readiness receipt for an installer-launched desktop. */
export function forkRestartReadiness(stateDir: string, args: readonly string[]) {
  const attempt = args.find((arg) => arg.startsWith(attemptFlag))?.slice(attemptFlag.length);
  if (!attempt || !/^restart\.\w{8}$/.test(attempt)) return undefined;
  const directory = NodePath.join(stateDir, attempt);
  const route = args.find((arg) => arg.startsWith(routeFlag))?.slice(routeFlag.length);
  let pending = true;
  return {
    route: () => (pending && route ? coordinatorRoute(route) : undefined),
    async markReady(backend: URL) {
      if (!pending) return false;
      pending = false;
      const health = new URL("/.well-known/t3/environment", backend);
      const temporary = NodePath.join(directory, "writing");
      await NodeFSP.writeFile(temporary, `${NodeProcess.pid}\n${health.href}\n`, { mode: 0o600 });
      await NodeFSP.rename(temporary, NodePath.join(directory, "ready"));
      return true;
    },
  };
}

/** Reads a failed installer restart once so the next manual launch can surface it. */
export async function consumeForkRestartFailure(stateDir: string) {
  const failure = NodePath.join(stateDir, "restart-failure");
  try {
    const message = await NodeFSP.readFile(failure, "utf8");
    await NodeFSP.unlink(failure);
    return message.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}
