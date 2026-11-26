import { createFileRoute } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
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
            <ForkDecisionInbox
              environmentId={environmentId}
              projectId={null}
              emptyState={<InboxEmptyState />}
            />
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

function InboxEmptyState() {
  return (
    <div className="flex flex-col items-center gap-4 pt-16 sm:pt-24 lg:pt-28 text-center">
      <div aria-hidden="true" className="relative h-24 w-32">
        <div className="absolute inset-x-4 bottom-1 h-4 rounded-full bg-black/8 blur-sm dark:bg-black/35" />
        <div className="absolute inset-x-0 bottom-2 h-9 rounded-lg inbox-tray-back" />
        <div className="absolute bottom-5 left-6 h-14 w-20 -rotate-6 overflow-hidden rounded-lg border shadow-sm inbox-envelope">
          <div className="absolute inset-x-0 top-0 h-7 inbox-envelope-fold" />
          <div className="absolute inset-x-0 bottom-3 flex justify-center gap-2">
            <span className="h-1.5 w-2.5 rounded-b-full border-b-2 inbox-envelope-eye" />
            <span className="h-1.5 w-2.5 rounded-b-full border-b-2 inbox-envelope-eye" />
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-2 h-5 rounded-b-xl border inbox-tray-front">
          <div className="mx-auto mt-1.5 h-1 w-6 rounded-full inbox-tray-handle" />
        </div>
      </div>
      <p className="text-sm font-medium text-foreground">
        <T>All caught up.</T>
      </p>
    </div>
  );
}

export const Route = createFileRoute("/_chat/inbox")({ component: InboxPage });
