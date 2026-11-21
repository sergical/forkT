import { useAtomValue } from "@effect/atom-react";
import { randomUUID } from "../../lib/utils";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { CommandId, type EnvironmentId, type ForkMemory, type ProjectId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { forkMemory } from "../../state/forkMemory";
import { useProjects, useVisibleThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";

export function ForkPage() {
  const projects = useProjects().filter((project) => project.archivedAt == null);
  const [scopeKey, setScopeKey] = useState("");
  const environments = [...new Set(projects.map((project) => project.environmentId))];
  const scopes = [
    ...projects.map((project) => ({
      key: `${project.environmentId}/${project.id}`,
      environmentId: project.environmentId,
      projectId: project.id,
      title: project.title,
    })),
    ...environments.map((environmentId) => ({
      key: `${environmentId}/personal`,
      environmentId,
      projectId: null,
      title: "Personal preferences",
    })),
  ];
  const selected = scopes.find((scope) => scope.key === scopeKey) ?? scopes[0];
  return (
    <SidebarInset className="h-dvh overflow-y-auto scrollbar-gutter-both">
      <main className="mx-auto w-full max-w-5xl space-y-8 p-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">T3 fork</h1>
          <p className="text-muted-foreground">
            A place for project decisions, preferences, and lessons that carry into the next task.
          </p>
        </header>
        {selected ? (
          <>
            <div className="max-w-sm">
              <label className="mb-2 block text-sm font-medium" htmlFor="fork-scope">
                Memory scope
              </label>
              <Select
                value={selected.key}
                onValueChange={(value) => {
                  if (value) setScopeKey(value);
                }}
              >
                <SelectTrigger id="fork-scope">
                  <SelectValue>{selected.title}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {scopes.map((scope) => (
                    <SelectItem key={scope.key} value={scope.key}>
                      {scope.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {selected.projectId ? (
              <CoordinatorControls
                key={`coordinator:${selected.key}`}
                environmentId={selected.environmentId}
                projectId={selected.projectId}
              />
            ) : null}
            <ForkInbox environmentId={selected.environmentId} projectId={selected.projectId} />
            <MemoryPanel
              key={selected.key}
              environmentId={selected.environmentId}
              projectId={selected.projectId}
            />
          </>
        ) : (
          <p>Add a project to start saving memory.</p>
        )}
      </main>
    </SidebarInset>
  );
}

function CoordinatorControls({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const dream = useAtomCommand(forkMemory.startDream, { label: "start Dream review" });
  const canDream = useAtomValue(forkMemory.startDream.permissionAtom(environmentId));
  const open = useAtomCommand(forkMemory.openCoordinator, { label: "open coordinator" });
  const allowed = useAtomValue(forkMemory.openCoordinator.permissionAtom(environmentId));
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enter = async (global: boolean) => {
    if (busy || !allowed) return;
    setBusy(true);
    setError(null);
    const result = await open({ environmentId, input: { projectId, global } });
    setBusy(false);
    if (result._tag === "Success")
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: result.value.threadId },
      });
    else setError(String(squashAtomCommandFailure(result)));
  };
  const startDream = async () => {
    if (busy || !canDream) return;
    setBusy(true);
    setError(null);
    const result = await dream({
      environmentId,
      input: { projectId, commandId: CommandId.make(randomUUID()) },
    });
    setBusy(false);
    if (result._tag === "Success")
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: result.value.threadId },
      });
    else setError(String(squashAtomCommandFailure(result)));
  };
  return (
    <section className="space-y-3 rounded-xl border p-5" aria-label="Coordinators">
      <h2 className="text-lg font-medium">One conversation to return to</h2>
      <p className="text-sm text-muted-foreground">
        Your project coordinator keeps the conversation and delegates work into task threads. The
        main coordinator handles work across projects.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button disabled={!allowed || busy} onClick={() => void enter(false)}>
          Open project coordinator
        </Button>
        <Button variant="outline" disabled={!allowed || busy} onClick={() => void enter(true)}>
          Open main coordinator
        </Button>
        <Button variant="outline" disabled={busy || !canDream} onClick={() => void startDream()}>
          Dream about this project
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function ForkInbox({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
}) {
  const pending = useVisibleThreadShells().filter(
    (thread) =>
      thread.environmentId === environmentId &&
      (projectId === null || thread.projectId === projectId) &&
      (thread.hasPendingApprovals ||
        thread.hasPendingUserInput ||
        thread.pendingSubagentRequest != null ||
        thread.hasActionableProposedPlan),
  );
  return (
    <section className="space-y-3" aria-label="Inbox">
      <h2 className="text-lg font-medium">
        Inbox <span className="text-muted-foreground">{pending.length}</span>
      </h2>
      {pending.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No questions or approvals need your attention.
        </p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {pending.map((thread) => (
            <li key={thread.id} className="flex items-center justify-between gap-3 p-3">
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: thread.id }}
                className="font-medium hover:underline"
              >
                {thread.title}
              </Link>
              <span className="text-sm text-muted-foreground">
                {thread.hasPendingApprovals
                  ? "Approval needed"
                  : thread.hasActionableProposedPlan
                    ? "Plan ready"
                    : "Question waiting"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MemoryPanel({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const entries = useEnvironmentQuery(
    forkMemory.search({ environmentId, input: { projectId, query: search } }),
  );
  const canSave = useAtomValue(forkMemory.save.permissionAtom(environmentId));
  return (
    <section className="space-y-4" aria-label="Memory">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex-1 text-lg font-medium">Memory</h2>
        <Button variant="outline" onClick={entries.refresh}>
          Refresh
        </Button>
        <Button disabled={!canSave} onClick={() => setEditing("new")}>
          Remember something
        </Button>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(query);
        }}
      >
        <div className="flex-1">
          <Input
            aria-label="Search memory"
            placeholder="Search decisions and lessons"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={500}
          />
        </div>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      {entries.error ? <p role="alert">{entries.error}</p> : null}
      {entries.isPending ? <p className="text-sm text-muted-foreground">Loading memory…</p> : null}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          {entries.data?.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No memories found. Save a decision or a preference to use in later tasks.
            </p>
          ) : null}
          {entries.data?.map((entry) => (
            <article key={entry.id} className="rounded-xl border p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {entry.kind} · revision {entry.revision}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setEditing(entry.id)}>
                  Read / edit
                </Button>
              </div>
              <h3 className="font-medium">{entry.title}</h3>
              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">
                {entry.excerpt}
              </p>
            </article>
          ))}
        </div>
        {editing ? (
          <MemorySelection
            key={editing}
            environmentId={environmentId}
            projectId={projectId}
            memoryId={editing}
            onSaved={() => {
              entries.refresh();
              setEditing(null);
            }}
            onClose={() => setEditing(null)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Select a memory to read its sources and revision history. Relevant notes are included in
            agent turns within this project.
          </p>
        )}
      </div>
    </section>
  );
}

function MemorySelection({
  environmentId,
  projectId,
  memoryId,
  onSaved,
  onClose,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  memoryId: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    memoryId === "new"
      ? null
      : forkMemory.get({ environmentId, input: { projectId, id: memoryId } }),
  );
  if (memoryId !== "new" && !query.data)
    return (
      <p role={query.error ? "alert" : "status"}>
        {query.error ??
          (query.isPending ? "Loading memory…" : "This memory is no longer available.")}
      </p>
    );
  return (
    <MemoryEditor
      key={query.data?.revision ?? "new"}
      environmentId={environmentId}
      projectId={projectId}
      memory={query.data}
      onSaved={onSaved}
      onClose={onClose}
    />
  );
}

function MemoryEditor({
  environmentId,
  projectId,
  memory,
  onSaved,
  onClose,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  memory: ForkMemory | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [id] = useState(() => memory?.id ?? randomUUID());
  const [title, setTitle] = useState(memory?.title ?? "");
  const [body, setBody] = useState(memory?.body ?? "");
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState<ForkMemory["kind"]>(memory?.kind ?? "decision");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const canSave = useAtomValue(forkMemory.save.permissionAtom(environmentId));
  const canForget = useAtomValue(forkMemory.forget.permissionAtom(environmentId));
  const save = useAtomCommand(forkMemory.save, { label: "save memory" });
  const forget = useAtomCommand(forkMemory.forget, { label: "forget memory" });
  const history = useEnvironmentQuery(
    memory ? forkMemory.history({ environmentId, input: { projectId, id } }) : null,
  );
  const submit = async () => {
    if (busy || !canSave) return;
    setBusy(true);
    setError(null);
    const result = await save({
      environmentId,
      input: {
        projectId,
        id,
        commandId: CommandId.make(randomUUID()),
        expectedRevision: memory?.revision ?? 0,
        kind,
        title,
        body,
        reason: reason.trim() || "Saved by the user.",
        sources: memory?.sources ?? [],
      },
    });
    setBusy(false);
    if (result._tag === "Success") onSaved();
    else setError(String(squashAtomCommandFailure(result)));
  };
  const remove = async () => {
    if (busy || !memory || !canForget) return;
    setBusy(true);
    const result = await forget({
      environmentId,
      input: { projectId, id, expectedRevision: memory.revision },
    });
    setBusy(false);
    if (result._tag === "Success") onSaved();
    else setError(String(squashAtomCommandFailure(result)));
  };
  return (
    <div className="space-y-4 rounded-xl border p-4">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h3 className="font-medium">{memory ? "Edit memory" : "New memory"}</h3>
        <label className="block space-y-2 text-sm">
          <span>Title</span>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            maxLength={160}
          />
        </label>
        <div className="space-y-2 text-sm">
          <label htmlFor="memory-kind">Kind</label>
          <Select
            value={kind}
            onValueChange={(value) => {
              if (value) setKind(value);
            }}
          >
            <SelectTrigger id="memory-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {(["preference", "decision", "lesson", "fact"] as const).map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <label className="block space-y-2 text-sm">
          <span>What to remember</span>
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            required
            maxLength={8000}
            rows={7}
          />
        </label>
        <label className="block space-y-2 text-sm">
          <span>Reason for this change</span>
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={1000}
            placeholder="What changed or why this matters"
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !canSave}>
            Save memory
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </form>
      {memory ? (
        <>
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Sources ({memory.sources.length})
            </summary>
            <div className="mt-2 space-y-3">
              {memory.sources.map((source) => (
                <blockquote
                  key={`${source.threadId}/${source.messageId}`}
                  className="border-l-2 pl-3 text-sm"
                >
                  <p className="whitespace-pre-wrap">{source.text}</p>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {source.threadId} / {source.messageId}
                  </p>
                </blockquote>
              ))}
              {memory.sources.length === 0 ? (
                <p className="text-sm text-muted-foreground">Saved directly by the user.</p>
              ) : null}
            </div>
          </details>
          <details>
            <summary className="cursor-pointer text-sm font-medium">Revision history</summary>
            {history.error ? <p role="alert">{history.error}</p> : null}
            {history.data?.map((revision) => (
              <div key={revision.revision} className="mt-3 space-y-1 border-t pt-3 text-sm">
                <p>
                  Revision {revision.revision} · {new Date(revision.updatedAt).toLocaleString()}
                </p>
                <p>{revision.reason}</p>
                <p className="whitespace-pre-wrap text-muted-foreground">{revision.body}</p>
              </div>
            ))}
          </details>
          {confirmForget ? (
            <div className="space-y-2 border-t pt-4">
              <p className="text-sm">
                Forget this memory and its source copies and history? This cannot be undone.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  disabled={busy || !canForget}
                  onClick={() => void remove()}
                >
                  Forget permanently
                </Button>
                <Button variant="ghost" onClick={() => setConfirmForget(false)}>
                  Keep memory
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" disabled={!canForget} onClick={() => setConfirmForget(true)}>
              Forget memory…
            </Button>
          )}
        </>
      ) : null}
    </div>
  );
}
