import { createFileRoute } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useLayoutEffect, useRef } from "react";

import { ForkDecisionInbox } from "../components/fork/ForkDecisionInbox";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { usePrimaryEnvironmentId } from "../state/environments";

function InboxPage() {
  const environmentId = usePrimaryEnvironmentId();
  const gt = useGT();
  const heading = useRef<HTMLHeadingElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focus the destination on navigation without disturbing restored scroll
  useLayoutEffect(() => heading.current?.focus({ preventScroll: true }), []);

  return (
    <SidebarInset
      {...workspaceAreaProps("inbox", 1)}
      role="main"
      className="h-dvh min-h-0 overflow-hidden"
    >
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <h1 ref={heading} tabIndex={-1} className="text-sm font-semibold outline-none">
          {gt("Inbox")}
        </h1>
      </WorkspacePageHeader>
      <div
        data-scroll-restoration-id="fork-inbox"
        className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-3xl px-5 py-4">
          {environmentId !== null && (
            <ForkDecisionInbox environmentId={environmentId} projectId={null} />
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/inbox")({ component: InboxPage });
