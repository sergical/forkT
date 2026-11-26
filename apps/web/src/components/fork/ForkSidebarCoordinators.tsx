import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  isForkMainCoordinatorThreadId,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { GitForkIcon, InboxIcon } from "lucide-react";
import { useGT } from "gt-react";
import { useState } from "react";
import { JumpHintBadge } from "../sidebar/SidebarThreadRow";
import { Link } from "@tanstack/react-router";
import { useInboxDecisionCount } from "./ForkDecisionInbox";

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

export function findMainCoordinatorInSidebar(
  threads: readonly EnvironmentThreadShell[],
  environmentId: EnvironmentId | null,
) {
  return threads.find(
    (thread) =>
      thread.archivedAt == null &&
      thread.deletedAt == null &&
      isForkMainCoordinatorThreadId(thread.id) &&
      thread.environmentId === environmentId,
  );
}

/**
 * T3 fork: the main coordinator's fixed row above the thread list. Project coordinators are
 * ordinary list rows, first in their project's folder.
 */
export function ForkSidebarCoordinators(props: {
  readonly environmentId: EnvironmentId | null;
  readonly main: EnvironmentThreadShell | undefined;
  readonly onNavigateInbox: () => void;
  readonly inboxJumpLabel: string | null;
  readonly jumpLabel: string | null;
  readonly routeRowThreadKey: string | null;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const open = useAtomCommand(forkMemory.openCoordinator, { reportFailure: true });
  const [opening, setOpening] = useState(false);
  const { main } = props;
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
    <div className="mb-2 flex flex-col gap-1" data-testid="fork-sidebar-coordinators">
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        disabled={main === undefined && (props.environmentId === null || opening)}
        className={rowClassName(active)}
        onClick={() => {
          if (
            main &&
            main.settledAt == null &&
            main.settledOverride !== "settled" &&
            main.snoozedUntil == null
          ) {
            props.onOpenThread(scopeThreadRef(main.environmentId, main.id));
          } else if (props.environmentId) void openMain(props.environmentId);
        }}
      >
        <GitForkIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">{gt("Main coordinator")}</span>
        {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
      </button>
      {props.environmentId && (
        <ForkInboxRow
          environmentId={props.environmentId}
          jumpLabel={props.inboxJumpLabel}
          onNavigate={props.onNavigateInbox}
        />
      )}
    </div>
  );
}

function ForkInboxRow({
  environmentId,
  jumpLabel,
  onNavigate,
}: {
  onNavigate: () => void;
  environmentId: EnvironmentId;
  jumpLabel: string | null;
}) {
  const gt = useGT();
  const count = useInboxDecisionCount(environmentId);
  return (
    <Link
      to="/inbox"
      onClick={onNavigate}
      className={rowClassName(false)}
      activeProps={{ className: rowClassName(true) }}
    >
      <InboxIcon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{gt("Inbox")}</span>
      {count > 0 && <span className="text-xs tabular-nums">{count}</span>}
      {jumpLabel && <JumpHintBadge label={jumpLabel} />}
    </Link>
  );
}

/** Leads a project folder whose coordinator was never opened; the first click creates it. */
export function ForkFolderCoordinatorRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly thread?: EnvironmentThreadShell;
  readonly active?: boolean;
  /** The folder's tree row, so arrow keys reach this row like its threads. */
  readonly folderRow: string;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const open = useAtomCommand(forkMemory.openCoordinator, { reportFailure: true });
  const [opening, setOpening] = useState(false);
  const openProject = async () => {
    const thread = props.thread;
    if (
      thread &&
      thread.settledAt == null &&
      thread.settledOverride !== "settled" &&
      thread.snoozedUntil == null
    ) {
      props.onOpenThread(scopeThreadRef(props.environmentId, thread.id));
      return;
    }
    setOpening(true);
    const result = await open({
      environmentId: props.environmentId,
      input: { global: false, projectId: props.projectId },
    });
    setOpening(false);
    if (result._tag === "Success")
      props.onOpenThread(scopeThreadRef(props.environmentId, result.value.threadId));
  };
  const thread = props.thread;
  const status =
    thread?.hasPendingApprovals ||
    thread?.hasPendingUserInput ||
    thread?.pendingSubagentRequest != null
      ? gt("Needs you")
      : thread?.runtime?.status === "running"
        ? gt("Working")
        : props.projectName;
  return (
    <li className="list-none">
      <button
        type="button"
        data-sidebar-row={`${props.folderRow}:coordinator`}
        data-sidebar-parent={props.folderRow}
        aria-current={props.active ? "page" : undefined}
        disabled={opening}
        className={cn(rowClassName(props.active ?? false), "h-auto min-h-10 px-2.5 ps-9 py-1")}
        onClick={() => void openProject()}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate">{gt("Coordinator")}</span>
          <span className="block truncate text-xs text-sidebar-muted-foreground">{status}</span>
        </span>
      </button>
    </li>
  );
}
