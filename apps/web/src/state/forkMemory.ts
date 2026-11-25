import { createForkMemoryAtoms } from "@t3tools/client-runtime/state/fork-memory";
import { connectionAtomRuntime } from "../connection/runtime";

export const forkMemory = createForkMemoryAtoms(connectionAtomRuntime);
