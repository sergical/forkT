import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { randomUUID } from "../../lib/utils";
import { Link, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { CommandId, type EnvironmentId, type ForkMemory, type ProjectId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { forkMemory } from "../../state/forkMemory";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentLookups } from "../CommandPaletteLookups";
import {
  groupMemoryEntries,
  memoryDetailSearch,
  memoryRefFromSearch,
  memoryRefKey,
  type MemoryRef,
} from "./memories.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";

declare module "@tanstack/react-router" {
  interface HistoryState {
    memoriesReset?: number;
  }
}

export function ForkPage() {
  const reset = useLocation({ select: (location) => location.state.memoriesReset });
  return <MemoriesPage key={reset ?? 0} />;
}

function MemoriesPage() {
  const gt = useGT();
  const search = useSearch({ from: "/_chat/memories" });
  const navigate = useNavigate();
  const selected = memoryRefFromSearch(search);
  const [query, setQuery] = useState("");
  const settledQuery = useDebouncedValue(query.trim(), 200);
  const [creating, setCreating] = useState(false);
  const { environments } = useEnvironments();
  const { projectEnvironmentLocationById } = useEnvironmentLookups();
  const projects = useProjects();
  const several = environments.length > 1;
  const environmentLabel = (environmentId: EnvironmentId) =>
    several ? (projectEnvironmentLocationById.get(environmentId)?.label ?? null) : null;
  const scopeLabel = (ref: Pick<MemoryRef, "environmentId" | "projectId">) => {
    const scope =
      ref.projectId === null
        ? "Personal"
        : (projects.find(
            (project) =>
              project.environmentId === ref.environmentId && project.id === ref.projectId,
          )?.title ?? "Unknown project");
    const location = environmentLabel(ref.environmentId);
    return location === null ? scope : `${scope} · ${location}`;
  };
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const targets = connected.flatMap((environment) => [
    { environmentId: environment.environmentId, projectId: null },
    ...projects
      .filter(
        (project) =>
          project.environmentId === environment.environmentId && project.archivedAt == null,
      )
      .map((project) => ({ environmentId: environment.environmentId, projectId: project.id })),
  ]);
  const open = (ref: MemoryRef | null) => {
    setCreating(false);
    void navigate({
      to: "/memories",
      search: ref === null ? {} : memoryDetailSearch(ref),
      state: true,
    });
  };
  return (
    <SidebarInset className="h-dvh overflow-y-auto scrollbar-gutter-both">
      <main className="mx-auto w-full max-w-5xl space-y-10 p-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">
            <T>Memories</T>
          </h1>
        </header>
        <section className="space-y-4" aria-label={gt("Memories")}>
          <div className="flex gap-2">
            <div className="flex-1">
              <Input
                type="search"
                aria-label={gt("Search memories")}
                placeholder={gt("Search memories")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                maxLength={500}
              />
            </div>
            <Button disabled={targets.length === 0} onClick={() => setCreating(true)}>
              <T>Remember something</T>
            </Button>
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-6">
              {environments.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  <T>Connect an environment to see its memories.</T>
                </p>
              ) : null}
              {environments.map((environment) => (
                <EnvironmentMemories
                  key={environment.environmentId}
                  environmentId={environment.environmentId}
                  label={environmentLabel(environment.environmentId)}
                  connected={environment.connection.phase === "connected"}
                  query={settledQuery}
                  selected={selected}
                />
              ))}
            </div>
            <div>
              {creating ? (
                <NewMemory
                  targets={targets}
                  scopeLabel={scopeLabel}
                  onSaved={open}
                  onClose={() => setCreating(false)}
                />
              ) : selected ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">{scopeLabel(selected)}</p>
                  <MemorySelection
                    key={memoryRefKey(selected)}
                    environmentId={selected.environmentId}
                    projectId={selected.projectId}
                    memoryId={selected.id}
                    onSaved={(saved) => open(saved === null ? null : selected)}
                    onClose={() => open(null)}
                  />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  <T>Select a memory.</T>
                </p>
              )}
            </div>
          </div>
        </section>
      </main>
    </SidebarInset>
  );
}

function EnvironmentMemories({
  environmentId,
  label,
  connected,
  query,
  selected,
}: {
  environmentId: EnvironmentId;
  label: string | null;
  connected: boolean;
  query: string;
  selected: MemoryRef | null;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const entries = useEnvironmentQuery(
    connected ? forkMemory.index({ environmentId, input: { query } }) : null,
  );
  const groups = groupMemoryEntries(entries.data ?? [], projects);
  const body = !connected ? (
    <p className="text-sm text-muted-foreground">
      Unavailable while {label ?? "this environment"} is disconnected.
    </p>
  ) : entries.error ? (
    <p role="alert" className="text-sm">
      {entries.error}
    </p>
  ) : entries.data === null ? (
    <p className="text-sm text-muted-foreground">Loading memories…</p>
  ) : groups.length === 0 ? (
    <p className="text-sm text-muted-foreground">
      {query === ""
        ? "No memories yet. Agents save preferences and decisions here as you work."
        : "No memories match your search."}
    </p>
  ) : (
    groups.map((group) => (
      <section key={group.key} className="space-y-1" aria-label={group.title ?? "Personal"}>
        <h3 className="px-2 text-xs font-medium text-muted-foreground">
          {group.projectId === null ? "Personal" : (group.title ?? "Unknown project")}
          {group.unavailable === "archived" ? " · Archived" : null}
        </h3>
        {group.unavailable !== null ? (
          <p className="px-2 text-sm text-muted-foreground">
            {group.unavailable === "archived"
              ? "Unavailable while the project is archived."
              : "Unavailable: this project is not loaded here."}
          </p>
        ) : (
          <ul>
            {group.entries.map((entry) => {
              const ref = { environmentId, projectId: entry.projectId, id: entry.id };
              const current = selected !== null && memoryRefKey(selected) === memoryRefKey(ref);
              return (
                <li key={entry.id}>
                  <Link
                    to="/memories"
                    search={memoryDetailSearch(ref)}
                    state={true}
                    aria-current={current ? "page" : undefined}
                    className="block truncate rounded-md px-2 py-1.5 text-sm hover:bg-accent aria-[current=page]:bg-accent aria-[current=page]:font-medium"
                  >
                    {entry.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    ))
  );
  return (
    <div className="space-y-4">
      {label === null ? null : <h2 className="text-sm font-medium">{label}</h2>}
      {body}
    </div>
  );
}

function NewMemory({
  targets,
  scopeLabel,
  onSaved,
  onClose,
}: {
  targets: ReadonlyArray<{ environmentId: EnvironmentId; projectId: ProjectId | null }>;
  scopeLabel: (ref: Pick<MemoryRef, "environmentId" | "projectId">) => string;
  onSaved: (ref: MemoryRef) => void;
  onClose: () => void;
}) {
  const keyOf = (target: (typeof targets)[number]) =>
    `${target.environmentId}/${target.projectId ?? "personal"}`;
  const [targetKey, setTargetKey] = useState(() => (targets[0] ? keyOf(targets[0]) : ""));
  const target = targets.find((candidate) => keyOf(candidate) === targetKey) ?? targets[0];
  if (!target) return null;
  return (
    <div className="space-y-3">
      <div className="space-y-2 text-sm">
        <label htmlFor="memory-scope">Save to</label>
        <Select
          value={keyOf(target)}
          onValueChange={(value) => {
            if (value) setTargetKey(value);
          }}
        >
          <SelectTrigger id="memory-scope">
            <SelectValue>{scopeLabel(target)}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {targets.map((candidate) => (
              <SelectItem key={keyOf(candidate)} value={keyOf(candidate)}>
                {scopeLabel(candidate)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <MemoryEditor
        key={keyOf(target)}
        environmentId={target.environmentId}
        projectId={target.projectId}
        memory={null}
        onSaved={(saved) => {
          if (saved !== null) onSaved({ ...target, id: saved.id });
        }}
        onClose={onClose}
      />
    </div>
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
  onSaved: (saved: ForkMemory | null) => void;
  onClose: () => void;
}) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const available =
    environments.some(
      (environment) =>
        environment.environmentId === environmentId && environment.connection.phase === "connected",
    ) &&
    (projectId === null ||
      projects.some(
        (project) =>
          project.environmentId === environmentId &&
          project.id === projectId &&
          project.archivedAt == null,
      ));
  const query = useEnvironmentQuery(
    available ? forkMemory.get({ environmentId, input: { projectId, id: memoryId } }) : null,
  );
  if (!query.data)
    return (
      <p role={query.error ? "alert" : "status"} className="text-sm">
        {query.error ??
          (available && query.isPending
            ? "Loading memory…"
            : "This memory was removed or is not available.")}
      </p>
    );
  return (
    <MemoryEditor
      key={query.data.revision}
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
  onSaved: (saved: ForkMemory | null) => void;
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
  const changed = useAtomSet(forkMemory.changes(environmentId));
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
    if (result._tag === "Success") {
      changed((count) => count + 1);
      onSaved(result.value);
    } else setError(String(squashAtomCommandFailure(result)));
  };
  const remove = async () => {
    if (busy || !memory || !canForget) return;
    setBusy(true);
    const result = await forget({
      environmentId,
      input: { projectId, id, expectedRevision: memory.revision },
    });
    setBusy(false);
    if (result._tag === "Success") {
      changed((count) => count + 1);
      onSaved(null);
    } else setError(String(squashAtomCommandFailure(result)));
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
