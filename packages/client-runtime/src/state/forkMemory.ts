import {
  WS_METHODS,
  type EnvironmentId,
  type ForkDreamDecideInput,
  type ForkDreamSuggestion,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentShellState } from "./shell.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import {
  createGuardedEnvironmentRpcQuery,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createForkMemoryAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  shellState: (id: EnvironmentId) => Atom.Atom<EnvironmentShellState>,
  threadShell: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThreadShell | null>,
) {
  // Bumped after a save or forget from this client, so every list and detail refetches.
  const changes = Atom.family((_environmentId: EnvironmentId) => Atom.make(0).pipe(Atom.keepAlive));
  const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    changes(environmentId);
  const dreamChanges = Atom.family((id: EnvironmentId) =>
    Atom.make((get) => {
      const shell = get(shellState(id));
      return `${shell.generation}/${shell.dreamResultSequence ?? 0}`;
    }),
  );
  const dreamRefresh = ({
    environmentId,
    input,
  }: {
    environmentId: EnvironmentId;
    input: { threadId: ThreadId };
  }) =>
    Atom.make((get) => {
      // Reusing a finished Dream creates a new receipt without another Dream run.
      const completedAt = get(threadShell({ environmentId, threadId: input.threadId }))?.latestRun
        ?.completedAt;
      return `${get(dreamChanges(environmentId))}/${completedAt ?? ""}`;
    });
  const decisionKey = ({
    environmentId,
    input,
  }: {
    environmentId: EnvironmentId;
    input: Pick<ForkDreamDecideInput, "threadId" | "suggestionId">;
  }) => JSON.stringify([environmentId, input.threadId, input.suggestionId]);
  const decisionStates = Atom.family((_key: string) =>
    Atom.make<{
      busy: boolean;
      confirmed: ForkDreamSuggestion["status"] | null;
      error: string | null;
    }>({ busy: false, confirmed: null, error: null }).pipe(Atom.setIdleTTL(0)),
  );
  const dreamReview = createGuardedEnvironmentRpcQuery(runtime, {
    label: "fork-dream:review",
    tag: WS_METHODS.forkDreamReview,
    refreshTrigger: dreamRefresh,
  });
  return {
    dreamReview,
    dreamDecisionState: (thread: ScopedThreadRef, suggestionId: string) =>
      decisionStates(
        decisionKey({
          environmentId: thread.environmentId,
          input: { threadId: thread.threadId, suggestionId },
        }),
      ),
    dreamResults: createGuardedEnvironmentRpcQuery(runtime, {
      label: "fork-dream:results",
      tag: WS_METHODS.forkDreamResults,
      refreshTrigger: dreamRefresh,
    }),
    decideDream: createEnvironmentRpcCommand(runtime, {
      label: "fork-dream:decide",
      tag: WS_METHODS.forkDreamDecide,
      concurrency: { mode: "singleFlight", key: decisionKey },
      onStart: (target, registry) =>
        registry.update(decisionStates(decisionKey(target)), (state) => ({
          ...state,
          busy: true,
          error: null,
        })),
      onSettled: (target, registry, exit) =>
        Effect.sync(() => {
          const { environmentId, input } = target;
          const state = decisionStates(decisionKey(target));
          if (Exit.isSuccess(exit)) {
            const confirmed =
              exit.value.suggestions.find((item) => item.suggestionId === input.suggestionId)
                ?.status ?? null;
            registry.set(state, { busy: false, confirmed, error: null });
            if (input.decision === "save" && confirmed === "saved")
              registry.update(changes(environmentId), (value) => value + 1);
          } else {
            registry.update(state, (previous) => ({
              ...previous,
              busy: false,
              error: String(Cause.squash(exit.cause)),
            }));
          }
          registry.refresh(
            dreamReview.query({ environmentId, input: { threadId: input.threadId } }),
          );
        }),
    }),
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

export {
  dreamDecisions,
  dreamMemoryKinds,
  dreamResultLabel,
  dreamReviewNote,
} from "./forkDreamCopy.ts";
