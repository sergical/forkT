import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createForkMemoryAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  // Bumped after a save or forget from this client, so every list and detail refetches.
  const changes = Atom.family((_environmentId: EnvironmentId) => Atom.make(0).pipe(Atom.keepAlive));
  const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    changes(environmentId);
  return {
    startDream: createEnvironmentRpcCommand(runtime, {
      label: "fork:start-dream",
      tag: WS_METHODS.forkDreamStart,
    }),
    openCoordinator: createEnvironmentRpcCommand(runtime, {
      label: "fork:open-coordinator",
      tag: WS_METHODS.forkCoordinatorOpen,
    }),
    changes,
    search: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "fork-memory:search",
      tag: WS_METHODS.forkMemorySearch,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    index: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "fork-memory:index",
      tag: WS_METHODS.forkMemoryIndex,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "fork-memory:get",
      tag: WS_METHODS.forkMemoryGet,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    history: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "fork-memory:history",
      tag: WS_METHODS.forkMemoryHistory,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "fork-memory:save",
      tag: WS_METHODS.forkMemorySave,
    }),
    forget: createEnvironmentRpcCommand(runtime, {
      label: "fork-memory:forget",
      tag: WS_METHODS.forkMemoryForget,
    }),
  };
}
