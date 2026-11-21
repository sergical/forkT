import { useAtomValue } from "@effect/atom-react";
import { CommandId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon, FolderPlusIcon, MessageSquareDashedIcon } from "lucide-react";
import { useRef, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useScratchProject } from "../../hooks/useScratchProject";
import { randomUUID } from "../../lib/utils";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useVisibleThreadShells,
} from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { forkMemory } from "../../state/forkMemory";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { pendingForkThreads } from "./forkInbox";

const GLOBAL_SCOPE = "global";
// One entrance on mount via @starting-style; nothing repaints afterwards.
const RISE =
  "motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-out starting:opacity-0 motion-safe:starting:translate-y-1.5";

const STARTERS = [
  "Catch me up on this project",
  "Plan the next change with me",
  "What did we decide last time?",
] as const;

export function ForkHome() {
  const threads = useVisibleThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const { scratchWorkspaceRootFor } = useScratchProject();
  const projects = sortScopedProjectsForSidebar(
    useProjects().filter(
      (project) =>
        project.archivedAt == null &&
        !isScratchProject(project, scratchWorkspaceRootFor(project.environmentId)),
    ),
    threads,
    "updated_at",
  );
  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, "Home")}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <div className="flex min-h-0 flex-1 overflow-y-auto">
          {/* A pending environment cannot prove the workspace is empty. */}
          {projects.length > 0 ? (
            <ForkDesk projects={projects} />
          ) : bootstrapped ? (
            <ForkFirstRun />
          ) : null}
        </div>
      </div>
    </SidebarInset>
  );
}

function ForkFirstRun() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const scratchTarget = scratchEnvironmentId(primaryEnvironmentId);
  return (
    <div className={`m-auto w-full max-w-xl px-6 py-16 ${RISE}`}>
      <img src="/fork-mark.svg" alt="" className="mb-8 size-11" />
      <h1 className="text-3xl font-semibold tracking-tight text-balance">
        One conversation that remembers.
      </h1>
      <p className="mt-3 max-w-md text-pretty text-muted-foreground">
        Give T3 fork a project folder. It opens a coordinator for it: you say what you want, it
        hands the work to task threads, checks the results, and keeps what you decide.
      </p>
      <div className="mt-8 flex flex-wrap gap-2">
        <Button onClick={() => openCommandPalette({ open: "add-project" })}>
          <FolderPlusIcon />
          Choose a project folder
        </Button>
        {scratchTarget === null ? null : (
          <Button variant="outline" onClick={() => void startScratchThread(scratchTarget)}>
            <MessageSquareDashedIcon />
            Start without a project
          </Button>
        )}
      </div>
      <ol className={`mt-14 space-y-5 border-t pt-8 delay-75 ${RISE}`}>
        <FirstRunStep n={1} title="Tell the coordinator what you want.">
          Plain words are enough. It asks when something is unclear.
        </FirstRunStep>
        <FirstRunStep n={2} title="It splits the work.">
          Task threads do the research, code and review, each with a check it must pass.
        </FirstRunStep>
        <FirstRunStep n={3} title="It remembers.">
          Decisions and preferences carry into later tasks. You can read and edit each one.
        </FirstRunStep>
      </ol>
    </div>
  );
}

function FirstRunStep({
  n,
  title,
  children,
}: {
  readonly n: number;
  readonly title: string;
  readonly children: string;
}) {
  return (
    <li className="grid grid-cols-[1.5rem_1fr] gap-x-3 text-sm">
      <span className="pt-px font-mono text-xs text-muted-foreground tabular-nums">{n}</span>
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-pretty text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

const projectKey = (project: EnvironmentProject) => `${project.environmentId}/${project.id}`;

function ForkDesk({ projects }: { readonly projects: ReadonlyArray<EnvironmentProject> }) {
  // Pinned on first render: recency order changes with thread activity while you type.
  const [scope, setScope] = useState(() => ({ key: projectKey(projects[0]!), global: false }));
  // A retry of the same text to the same coordinator reuses its command, so it cannot run twice.
  const [attempt, setAttempt] = useState<{
    readonly target: string;
    readonly text: string;
    readonly commandId: CommandId;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();
  const open = useAtomCommand(forkMemory.openCoordinator, { label: "open coordinator" });

  const isGlobal = scope.global;
  // The main coordinator lives in the selected project's environment and still needs a host project.
  const project = projects.find((candidate) => projectKey(candidate) === scope.key) ?? projects[0]!;
  const allowed = useAtomValue(forkMemory.openCoordinator.permissionAtom(project.environmentId));
  const memories = useEnvironmentQuery(
    forkMemory.search({
      environmentId: project.environmentId,
      input: { projectId: isGlobal ? null : project.id, query: "" },
    }),
  );
  const pending = pendingForkThreads(
    useVisibleThreadShells(),
    project.environmentId,
    isGlobal ? null : project.id,
  );
  const remembered = memories.data ?? [];
  const coordinatorName = isGlobal ? "Main coordinator" : `${project.title} coordinator`;
  const canSend = allowed && !busy && draft.trim() !== "";

  const send = async () => {
    if (!canSend) return;
    const text = draft.trim();
    const target = `${isGlobal ? GLOBAL_SCOPE : "project"}:${projectKey(project)}`;
    const commandId =
      attempt?.target === target && attempt.text === text
        ? attempt.commandId
        : CommandId.make(randomUUID());
    setAttempt({ target, text, commandId });
    setBusy(true);
    setError(null);
    const result = await open({
      environmentId: project.environmentId,
      input: { projectId: project.id, global: isGlobal, message: { commandId, text } },
    });
    if (result._tag !== "Success") {
      setBusy(false);
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    setDraft("");
    setAttempt(null);
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: project.environmentId, threadId: result.value.threadId },
    }).finally(() => setBusy(false));
  };

  return (
    <div className={`m-auto w-full max-w-2xl px-6 py-16 ${RISE}`}>
      <p className="text-sm text-muted-foreground">
        {coordinatorName}
        {memories.isSuccess ? (
          <>
            {" · "}
            {remembered.length === 0
              ? "nothing remembered yet"
              : `remembers ${remembered.length >= 100 ? "100+" : remembered.length} ${remembered.length === 1 ? "thing" : "things"}`}
          </>
        ) : null}
      </p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight text-balance">
        What should we work on?
      </h1>

      <form
        className="mt-6 rounded-2xl border bg-card shadow-xs transition-[border-color,box-shadow] duration-150 focus-within:border-ring/60 focus-within:shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={textareaRef}
          aria-label={`Message the ${coordinatorName}`}
          className="block max-h-[40vh] min-h-24 w-full resize-none bg-transparent px-4 pt-4 text-base outline-none [field-sizing:content] placeholder:text-muted-foreground/70 pointer-fine:text-sm"
          placeholder="Say what you need. The coordinator plans it, hands it out, and reports back."
          value={draft}
          maxLength={20_000}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void send();
          }}
        />
        <div className="flex items-center gap-2 p-2 pl-3">
          <Select
            value={isGlobal ? GLOBAL_SCOPE : projectKey(project)}
            onValueChange={(value) => {
              if (value === GLOBAL_SCOPE) setScope({ key: projectKey(project), global: true });
              else if (value) setScope({ key: value, global: false });
            }}
          >
            <SelectTrigger size="sm" variant="ghost" aria-label="Coordinator">
              <SelectValue>{isGlobal ? "All projects" : project.title}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {projects.map((candidate) => (
                <SelectItem key={projectKey(candidate)} value={projectKey(candidate)}>
                  {candidate.title}
                </SelectItem>
              ))}
              <SelectItem value={GLOBAL_SCOPE}>All projects</SelectItem>
            </SelectPopup>
          </Select>
          <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
            {busy ? "Opening the coordinator…" : "Enter to send"}
          </span>
          <Button type="submit" size="icon-sm" aria-label="Send" disabled={!canSend}>
            <ArrowUpIcon />
          </Button>
        </div>
      </form>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!allowed ? (
        <p className="mt-3 text-sm text-muted-foreground">
          This connection cannot open coordinators.
        </p>
      ) : null}

      <div className="mt-3 -ml-2.5 flex flex-wrap gap-1.5">
        {STARTERS.map((starter) => (
          <Button
            key={starter}
            size="sm"
            variant="ghost-muted"
            disabled={busy}
            onClick={() => {
              setDraft(starter);
              textareaRef.current?.focus();
            }}
          >
            {starter}
          </Button>
        ))}
      </div>

      <div className={`mt-14 grid gap-10 border-t pt-8 delay-75 sm:grid-cols-2 ${RISE}`}>
        <section aria-label="Waiting on you">
          <h2 className="text-sm font-medium">
            Waiting on you
            {pending.length > 0 ? (
              <span className="ml-1.5 text-muted-foreground tabular-nums">{pending.length}</span>
            ) : null}
          </h2>
          {pending.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Nothing. Questions and approvals from task threads land here.
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {pending.slice(0, 5).map(({ thread, reason }) => (
                <li key={thread.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <Link
                    to="/$environmentId/$threadId"
                    params={{ environmentId: thread.environmentId, threadId: thread.id }}
                    className="truncate hover:underline"
                  >
                    {thread.title}
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">{reason}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label="Remembered">
          <h2 className="flex items-baseline text-sm font-medium">
            Remembered
            <Link
              to="/fork"
              className="ml-auto text-xs text-muted-foreground hover:text-foreground"
            >
              Open memory
            </Link>
          </h2>
          {remembered.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {memories.isPending
                ? "Loading…"
                : (memories.error ??
                  "Decisions you make with the coordinator collect here, with their sources.")}
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {remembered.slice(0, 4).map((memory) => (
                <li key={memory.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate">{memory.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{memory.kind}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
