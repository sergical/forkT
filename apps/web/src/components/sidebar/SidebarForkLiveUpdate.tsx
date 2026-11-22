import { useAtomValue } from "@effect/atom-react";
import type { ForkLiveUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";
import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { environmentThreadShells } from "~/state/threads";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { countForkUpdateRuns } from "./forkUpdateRunCount";

const forkUpdateStateAtom = Atom.make(
  Stream.callback<ForkLiveUpdateState>((queue) =>
    Effect.gen(function* () {
      const bridge = window.desktopBridge?.forkLiveUpdate;
      if (!bridge) return;
      let received = false;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          bridge.onState((state) => {
            received = true;
            Queue.offerUnsafe(queue, state);
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      const initial = yield* Effect.promise(() => bridge.getState().catch(() => null));
      if (!received && initial !== null) Queue.offerUnsafe(queue, initial);
      return yield* Effect.never;
    }),
  ),
).pipe(Atom.withLabel("desktop:fork-live-update-state"));

const forkUpdateRunCountAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  return environmentId === null
    ? 0
    : countForkUpdateRuns(get(environmentThreadShells.environmentThreadsAtom(environmentId)));
}).pipe(Atom.withLabel("desktop:fork-live-update-run-count"));

export function SidebarForkLiveUpdate() {
  if (typeof window === "undefined" || !window.desktopBridge?.forkLiveUpdate) return null;
  return <ForkLiveUpdateNotice />;
}

function ForkLiveUpdateNotice() {
  const gt = useGT();
  const state = AsyncResult.getOrElse(useAtomValue(forkUpdateStateAtom), () => null);
  if (!state || (!state.ready && !state.failure)) return null;

  const label = state.failure ? gt("Update build failed") : gt("Update ready, restart");
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Dialog>
          <DialogTrigger render={<SidebarMenuButton />}>
            {state.failure ? <TriangleAlertIcon /> : <RotateCwIcon />}
            <span>{label}</span>
          </DialogTrigger>
          <ForkLiveUpdateDetails state={state} label={label} />
        </Dialog>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function ForkLiveUpdateDetails({ state, label }: { state: ForkLiveUpdateState; label: string }) {
  const gt = useGT();
  const running = useAtomValue(forkUpdateRunCountAtom);
  const ready = state.ready;
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState(false);

  async function restart(sha: string) {
    setRestarting(true);
    const accepted = await window.desktopBridge?.forkLiveUpdate?.restart(sha).catch(() => false);
    if (!accepted) {
      setRestartError(true);
      setRestarting(false);
    }
  }

  return (
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>{label}</DialogTitle>
        <DialogDescription>
          {state.failure && <T>The installed app is unchanged.</T>}
          {ready && (
            <span className="block tabular-nums">
              {gt(
                "{count, plural, one {Restarting will stop {count} agent run.} other {Restarting will stop {count} agent runs.}}",
                { count: running },
              )}
            </span>
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="grid max-h-[50vh] gap-3 overflow-auto px-6 py-2 text-sm">
        {state.failure && (
          <div className="grid min-w-0 gap-2">
            <p className="break-all text-muted-foreground">{state.failure.logPath}</p>
            <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
              {state.failure.tail}
            </pre>
          </div>
        )}
        {ready && <p className="whitespace-pre-line wrap-anywhere">{ready.commits.join("\n")}</p>}
        {restartError && (
          <p role="alert">
            <T>The app could not restart. Open this notice again to retry.</T>
          </p>
        )}
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          <T>Close</T>
        </DialogClose>
        {ready && (
          <Button disabled={restarting} onClick={() => void restart(ready.sha)}>
            <T>Restart</T>
          </Button>
        )}
      </DialogFooter>
    </DialogPopup>
  );
}
