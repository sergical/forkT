import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  forkCoordinatorProjectId,
  isForkMainCoordinatorThreadId,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ChevronDownIcon, GitForkIcon, ListIcon, MessagesSquareIcon } from "lucide-react";
import { useGT } from "gt-react";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { splitOnboardingProjectPath } from "../../onboarding/projectImport.logic";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { forkMemory } from "../../state/forkMemory";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProjectFavicon } from "../ProjectFavicon";

const EXPANDED_PROJECTS_KEY = "fork:sidebar-expanded-projects";
const EXPANDED_PROJECTS_SCHEMA = Schema.Array(Schema.String);
const NO_EXPANDED_PROJECTS: readonly string[] = [];

const rowClassName = (active: boolean) =>
  cn(
    "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    active
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover",
  );

/**
 * T3 fork: coordinators live here instead of in the thread list. The main one is a fixed row;
 * each project folds open to its coordinator, then a link that filters the list to its threads.
 * The folder sidebar already lists projects, so it passes none and keeps project coordinators.
 */
export function ForkSidebarCoordinators(props: {
  readonly environmentId: EnvironmentId | null;
  /** Every thread shell, coordinators included. */
  readonly threads: readonly EnvironmentThreadShell[];
  readonly projects: readonly SidebarProjectSnapshot[];
  readonly routeRowThreadKey: string | null;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
  readonly onShowProjectThreads: (project: SidebarProjectSnapshot) => void;
}) {
  const gt = useGT();
  const open = useAtomCommand(forkMemory.openCoordinator, { reportFailure: true });
  const [opening, setOpening] = useState<string | null>(null);
  const [expanded, setExpanded] = useLocalStorage(
    EXPANDED_PROJECTS_KEY,
    NO_EXPANDED_PROJECTS,
    EXPANDED_PROJECTS_SCHEMA,
  );

  const isLive = (thread: EnvironmentThreadShell) =>
    thread.archivedAt == null && thread.deletedAt == null;
  // Each environment has its own main coordinator; this row opens the primary one's.
  const main = props.threads.find(
    (thread) =>
      isLive(thread) &&
      isForkMainCoordinatorThreadId(thread.id) &&
      thread.environmentId === props.environmentId,
  );
  const coordinatorByProject = new Map<string, EnvironmentThreadShell>();
  const threadCountByProject = new Map<string, number>();
  for (const thread of props.threads) {
    if (!isLive(thread)) continue;
    const key = `${thread.environmentId}:${thread.projectId}`;
    if (forkCoordinatorProjectId(thread.id) !== null) coordinatorByProject.set(key, thread);
    else if (!isForkMainCoordinatorThreadId(thread.id))
      threadCountByProject.set(key, (threadCountByProject.get(key) ?? 0) + 1);
  }

  const keyOf = (thread: EnvironmentThreadShell) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  // A coordinator that was never opened is created on first click.
  const openCoordinator = async (
    key: string,
    input: { environmentId: EnvironmentId; projectId?: ProjectId; global: boolean },
  ) => {
    if (opening !== null) return;
    setOpening(key);
    const result = await open({
      environmentId: input.environmentId,
      input: { global: input.global, ...(input.projectId ? { projectId: input.projectId } : {}) },
    });
    setOpening(null);
    if (result._tag === "Success")
      props.onOpenThread(scopeThreadRef(input.environmentId, result.value.threadId));
  };

  const mainLabel = gt("Main coordinator");
  return (
    <div className="mb-2 flex flex-col gap-px" data-testid="fork-sidebar-coordinators">
      <button
        type="button"
        aria-current={main && props.routeRowThreadKey === keyOf(main) ? "page" : undefined}
        disabled={main === undefined && props.environmentId === null}
        className={rowClassName(main !== undefined && props.routeRowThreadKey === keyOf(main))}
        onClick={() => {
          if (main) props.onOpenThread(scopeThreadRef(main.environmentId, main.id));
          else if (props.environmentId)
            void openCoordinator("main", { environmentId: props.environmentId, global: true });
        }}
      >
        <GitForkIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">{mainLabel}</span>
      </button>
      {props.projects.length > 0 ? (
        <>
          <p className="mt-2 flex h-8 items-center px-2 text-xs font-medium text-sidebar-muted-foreground">
            {gt("Projects", { $context: "sidebar section" })}
          </p>
          {props.projects.map((project) => {
            const isOpen = expanded.includes(project.projectKey);
            // A group can hold several projects, such as two clones; each has its own coordinator.
            const members = project.memberProjects.map((member) => ({
              member,
              coordinator: coordinatorByProject.get(`${member.environmentId}:${member.id}`),
            }));
            const threadCount = project.memberProjectRefs.reduce(
              (total, ref) =>
                total + (threadCountByProject.get(`${ref.environmentId}:${ref.projectId}`) ?? 0),
              0,
            );
            const coordinatorActive = members.some(
              ({ coordinator }) =>
                coordinator !== undefined && props.routeRowThreadKey === keyOf(coordinator),
            );
            const name = splitOnboardingProjectPath(project.workspaceRoot).name;
            return (
              <div key={project.projectKey} className="flex flex-col gap-px">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  className={rowClassName(!isOpen && coordinatorActive)}
                  onClick={() =>
                    setExpanded(
                      isOpen
                        ? expanded.filter((key) => key !== project.projectKey)
                        : [...expanded, project.projectKey],
                    )
                  }
                >
                  <ProjectFavicon project={project} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <ChevronDownIcon
                    aria-hidden
                    className={cn(
                      "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
                      !isOpen && "-rotate-90",
                    )}
                  />
                </button>
                {isOpen ? (
                  <div className="flex flex-col gap-px ps-4">
                    {members.map(({ member, coordinator }) => {
                      const memberKey = `${member.environmentId}:${member.id}`;
                      const active =
                        coordinator !== undefined && props.routeRowThreadKey === keyOf(coordinator);
                      return (
                        <button
                          key={memberKey}
                          type="button"
                          aria-current={active ? "page" : undefined}
                          disabled={opening === memberKey}
                          className={rowClassName(active)}
                          onClick={() => {
                            if (coordinator)
                              props.onOpenThread(
                                scopeThreadRef(coordinator.environmentId, coordinator.id),
                              );
                            else
                              void openCoordinator(memberKey, {
                                environmentId: member.environmentId,
                                projectId: member.id,
                                global: false,
                              });
                          }}
                        >
                          <MessagesSquareIcon aria-hidden className="size-4 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">
                            {members.length > 1
                              ? splitOnboardingProjectPath(member.workspaceRoot).name
                              : gt("Coordinator")}
                          </span>
                        </button>
                      );
                    })}
                    {threadCount > 0 ? (
                      <button
                        type="button"
                        className={cn(rowClassName(false), "text-sidebar-muted-foreground")}
                        onClick={() => props.onShowProjectThreads(project)}
                      >
                        <ListIcon aria-hidden className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                          {gt(
                            "{count, plural, one {Show {count} thread} other {Show {count} threads}}",
                            { count: threadCount },
                          )}
                        </span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
