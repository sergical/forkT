import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";

import { isElectron } from "../../env";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { forkMemory } from "../../state/forkMemory";
import { useAtomCommand } from "../../state/use-atom-command";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ForkOnboarding } from "./ForkOnboarding";

/** T3 fork: home is the main coordinator's thread. Until it can open, its onboarding runs here. */
export function ForkHome() {
  const environmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const open = useAtomCommand(forkMemory.openCoordinator, { reportFailure: false });
  const [failed, setFailed] = useState(false);

  const openMain = useEffectEvent((target: EnvironmentId, isLive: () => boolean) => {
    void open({ environmentId: target, input: { global: true } }).then((result) => {
      if (!isLive()) return;
      if (result._tag !== "Success") {
        setFailed(true);
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: target, threadId: result.value.threadId },
        replace: true,
      });
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the main coordinator on the server, then leaves for its thread; opening is idempotent
  useEffect(() => {
    if (environmentId === null) return;
    let live = true;
    openMain(environmentId, () => live);
    return () => {
      live = false;
    };
  }, [environmentId]);

  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, "Home")}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        {failed && environmentId !== null ? <ForkOnboarding environmentId={environmentId} /> : null}
      </div>
    </SidebarInset>
  );
}
