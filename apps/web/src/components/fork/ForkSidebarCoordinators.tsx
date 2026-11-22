import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  isForkMainCoordinatorThreadId,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { GitForkIcon } from "lucide-react";
import { useGT } from "gt-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { forkMemory } from "../../state/forkMemory";
import { useAtomCommand } from "../../state/use-atom-command";

const rowClassName = (active: boolean) =>
  cn(
    "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    active
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover",
  );

/**
 * T3 fork: the main coordinator's fixed row above the thread list. Project coordinators are
 * ordinary list rows, first in their project's folder.
 */
export function ForkSidebarCoordinators(props: {
  readonly environmentId: EnvironmentId | null;
  /** Every thread shell, coordinators included. */
  readonly threads: readonly EnvironmentThreadShell[];
  readonly routeRowThreadKey: string | null;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const open = useAtomCommand(forkMemory.openCoordinator, { reportFailure: true });
  const [opening, setOpening] = useState(false);
  // Each environment has its own main coordinator; this row opens the primary one's.
  const main = props.threads.find(
    (thread) =>
      thread.archivedAt == null &&
      thread.deletedAt == null &&
      isForkMainCoordinatorThreadId(thread.id) &&
      thread.environmentId === props.environmentId,
  );
  const active =
    main !== undefined &&
    props.routeRowThreadKey === scopedThreadKey(scopeThreadRef(main.environmentId, main.id));
  // A coordinator that was never opened is created on first click.
  const openMain = async (environmentId: EnvironmentId) => {
    if (opening) return;
    setOpening(true);
    const result = await open({ environmentId, input: { global: true } });
    setOpening(false);
    if (result._tag === "Success")
      props.onOpenThread(scopeThreadRef(environmentId, result.value.threadId));
  };

  return (
    <div className="mb-2 flex flex-col gap-px" data-testid="fork-sidebar-coordinators">
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        disabled={main === undefined && (props.environmentId === null || opening)}
        className={rowClassName(active)}
        onClick={() => {
          if (main) props.onOpenThread(scopeThreadRef(main.environmentId, main.id));
          else if (props.environmentId) void openMain(props.environmentId);
        }}
      >
        <GitForkIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">{gt("Main coordinator")}</span>
      </button>
    </div>
  );
}

/** Leads a project folder whose coordinator was never opened; the first click creates it. */
export function ForkFolderCoordinatorRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const open = useAtomCommand(forkMemory.openCoordinator, { reportFailure: true });
  const [opening, setOpening] = useState(false);
  const openProject = async () => {
    setOpening(true);
    const result = await open({
      environmentId: props.environmentId,
      input: { global: false, projectId: props.projectId },
    });
    setOpening(false);
    if (result._tag === "Success")
      props.onOpenThread(scopeThreadRef(props.environmentId, result.value.threadId));
  };
  return (
    <li className="list-none">
      <button
        type="button"
        disabled={opening}
        className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 ps-9 text-left text-sm text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => void openProject()}
      >
        <span className="min-w-0 flex-1 truncate">{gt("Coordinator")}</span>
      </button>
    </li>
  );
}
