import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createForkMemoryAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  const search = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "fork-memory:search",
    tag: WS_METHODS.forkMemorySearch,
    staleTimeMs: 0,
  });
  const history = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "fork-memory:history",
    tag: WS_METHODS.forkMemoryHistory,
    staleTimeMs: 0,
  });
  return {
    startDream: createEnvironmentRpcCommand(runtime, {
      label: "fork:start-dream",
      tag: WS_METHODS.forkDreamStart,
    }),
    openCoordinator: createEnvironmentRpcCommand(runtime, {
      label: "fork:open-coordinator",
      tag: WS_METHODS.forkCoordinatorOpen,
    }),
    search,
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "fork-memory:get",
      tag: WS_METHODS.forkMemoryGet,
      staleTimeMs: 0,
    }),
    history,
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
