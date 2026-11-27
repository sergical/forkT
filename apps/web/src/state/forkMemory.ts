import { createForkMemoryAtoms } from "@t3tools/client-runtime/state/fork-memory";
import { connectionAtomRuntime } from "../connection/runtime";

import { environmentShell } from "./shell";
import { environmentThreadShells } from "./threads";

export const forkMemory = createForkMemoryAtoms(
  connectionAtomRuntime,
  environmentShell.stateValueAtom,
  environmentThreadShells.quietThreadShellAtom,
);
