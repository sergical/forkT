import {
  EnvironmentId,
  MAIN_COORDINATOR_MEMORY_SCOPE,
  ProjectId,
  type ForkMemoryIndexEntry,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";

export interface MemoryRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly id: string;
}

/** `/fork` search params. No `projectId` means personal memory. */
export interface MemoriesSearch {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly memory?: string;
}

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

export function validateMemoriesSearch(raw: Record<string, unknown>): MemoriesSearch {
  const environmentId = text(raw.environmentId);
  const projectId = text(raw.projectId);
  const memory = text(raw.memory);
  return {
    ...(environmentId === undefined ? {} : { environmentId: EnvironmentId.make(environmentId) }),
    ...(projectId === undefined ? {} : { projectId: ProjectId.make(projectId) }),
    ...(memory === undefined ? {} : { memory }),
  };
}

export function memoryDetailSearch(ref: MemoryRef): MemoriesSearch {
  return {
    environmentId: ref.environmentId,
    ...(ref.projectId === null ? {} : { projectId: ref.projectId }),
    memory: ref.id,
  };
}

export function memoryRefFromSearch(search: MemoriesSearch): MemoryRef | null {
  if (search.environmentId === undefined || search.memory === undefined) return null;
  return {
    environmentId: search.environmentId,
    projectId: search.projectId ?? null,
    id: search.memory,
  };
}

export const memoryRefKey = (ref: MemoryRef) =>
  `${ref.environmentId}/${ref.projectId ?? "personal"}/${ref.id}`;

export interface MemoryScopeProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly archivedAt?: string | null | undefined;
}

export interface MemoryScopeGroup {
  readonly key: string;
  readonly projectId: ProjectId | null;
  /** Null for personal memory and for a project this client does not know. */
  readonly title: string | null;
  /** Its memories exist but cannot be opened here. */
  readonly unavailable: "archived" | "unknown" | null;
  readonly entries: ReadonlyArray<ForkMemoryIndexEntry>;
}

/** Personal first, then projects in the order given; the server's order holds within a group. */
export function groupMemoryEntries(
  entries: ReadonlyArray<ForkMemoryIndexEntry>,
  projects: ReadonlyArray<MemoryScopeProject>,
  mainCoordinatorLabel: string,
): MemoryScopeGroup[] {
  const byScope = new Map<string, ForkMemoryIndexEntry[]>();
  for (const entry of entries) {
    const key = entry.projectId ?? "personal";
    const list = byScope.get(key);
    if (list) list.push(entry);
    else byScope.set(key, [entry]);
  }
  const groups: MemoryScopeGroup[] = [];
  const personal = byScope.get("personal");
  if (personal) {
    groups.push({
      key: "personal",
      projectId: null,
      title: null,
      unavailable: null,
      entries: personal,
    });
  }
  const known = new Set<string>();
  for (const project of [
    { id: MAIN_COORDINATOR_MEMORY_SCOPE, title: mainCoordinatorLabel, archivedAt: null },
    ...projects,
  ]) {
    known.add(project.id);
    const list = byScope.get(project.id);
    if (!list) continue;
    groups.push({
      key: project.id,
      projectId: project.id,
      title: project.title,
      unavailable: project.archivedAt ? "archived" : null,
      entries: list,
    });
  }
  for (const [key, list] of byScope) {
    if (key === "personal" || known.has(key)) continue;
    groups.push({
      key,
      projectId: ProjectId.make(key),
      title: null,
      unavailable: "unknown",
      entries: list,
    });
  }
  return groups;
}

export interface MemoryPaletteEntry {
  readonly value: string;
  readonly title: string;
  /** Tells same-titled memories apart: "Personal" or the project's name. */
  readonly scopeLabel: string;
  readonly search: MemoriesSearch;
}

/** Memories a palette search found, ready to open. Unavailable scopes are left out. */
export function memoryPaletteEntries(input: {
  readonly results: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly entries: ReadonlyArray<ForkMemoryIndexEntry>;
    readonly projects: ReadonlyArray<MemoryScopeProject>;
    /** Set when more than one environment is listed. */
    readonly environmentLabel?: string;
  }>;
  readonly personalLabel: string;
  readonly mainCoordinatorLabel: string;
}): MemoryPaletteEntry[] {
  return input.results.flatMap(({ environmentId, entries, projects, environmentLabel }) =>
    groupMemoryEntries(entries, projects, input.mainCoordinatorLabel).flatMap((group) => {
      if (group.unavailable !== null) return [];
      const scope = group.title ?? input.personalLabel;
      const scopeLabel = environmentLabel === undefined ? scope : `${scope} · ${environmentLabel}`;
      return group.entries.map((entry) => {
        const ref = { environmentId, projectId: entry.projectId, id: entry.id };
        return {
          value: `memory:${memoryRefKey(ref)}`,
          title: entry.title,
          scopeLabel,
          search: memoryDetailSearch(ref),
        };
      });
    }),
  );
}

export type MemoryChangeTarget = Omit<MemoryRef, "environmentId"> & {
  readonly environmentId: EnvironmentId | null;
};

const targetKey = (target: MemoryChangeTarget) =>
  `${target.environmentId ?? ""}/${target.projectId ?? "personal"}/${target.id}`;

export interface MemoryChange {
  readonly action: "saved" | "updated" | "removed";
  readonly title: string | null;
  /**
   * The memory the call named; null when its input was too large to keep. A null
   * `environmentId` is the thread's own environment.
   */
  readonly memory: MemoryChangeTarget | null;
  /** Whether the line opens the memory: never once this thread removed it. */
  readonly linked: boolean;
  /** Retries of one save share it, so a thread shows one line for them. */
  readonly commandId: string | null;
}

const MEMORY_TOOL =
  /^(?:(?:mcp__)?t3[-_]?code(?:[-_]direct)?(?:__|[.:/_]))?t3_memory_(save|forget)$/i;

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  // Cursor keeps the MCP args envelope.
  return typeof fields.toolName === "string" && fields.args !== undefined
    ? record(fields.args)
    : fields;
}

function outputFailed(output: unknown): boolean {
  const fields = record(output);
  return fields?.isError === true || fields?.is_error === true || fields?.error != null;
}

/**
 * A successful memory save or forget, read from the tool call alone. Reads, searches and
 * failures return null and keep their normal tool row.
 */
export function memoryChangeFromToolItem(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>,
    "toolName" | "status" | "input" | "output"
  >,
): MemoryChange | null {
  const tool = item.toolName === null ? undefined : MEMORY_TOOL.exec(item.toolName.trim())?.[1];
  if (tool === undefined) return null;
  if (item.status !== "completed" || outputFailed(item.output)) return null;
  const input = record(item.input);
  const id = text(input?.id);
  const projectId = input?.projectId;
  const scope =
    projectId === null ? null : typeof projectId === "string" ? text(projectId) : undefined;
  const environmentId = text(input?.environmentId);
  const memory: MemoryChangeTarget | null =
    id === undefined || scope === undefined
      ? null
      : {
          environmentId: environmentId === undefined ? null : EnvironmentId.make(environmentId),
          projectId: scope === null ? null : ProjectId.make(scope),
          id,
        };
  if (tool.toLowerCase() === "forget") {
    return { action: "removed", title: null, memory, linked: false, commandId: null };
  }
  const revision = input?.expectedRevision;
  return {
    action: typeof revision === "number" && revision > 0 ? "updated" : "saved",
    title: text(input?.title) ?? null,
    memory,
    linked: memory !== null,
    commandId: text(input?.commandId) ?? null,
  };
}

const hasChange = <T extends object>(entry: T): entry is T & { readonly change: MemoryChange } =>
  "change" in entry;

/**
 * One line per save `commandId`, so a retried call shows once. A memory this thread removed
 * stops linking, and its removal line takes the title an earlier save here gave it.
 */
export function settleMemoryChanges<T extends object>(entries: ReadonlyArray<T>): T[] {
  const removed = new Set<string>();
  const titles = new Map<string, string>();
  for (const entry of entries) {
    if (!hasChange(entry) || entry.change.memory === null) continue;
    const key = targetKey(entry.change.memory);
    if (entry.change.action === "removed") removed.add(key);
    else if (entry.change.title !== null) titles.set(key, entry.change.title);
  }
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    if (!hasChange(entry)) return [entry];
    const { change } = entry;
    if (change.commandId !== null) {
      if (seen.has(change.commandId)) return [];
      seen.add(change.commandId);
    }
    const key = change.memory === null ? null : targetKey(change.memory);
    if (key === null || (!removed.has(key) && change.action !== "removed")) return [entry];
    return [
      {
        ...entry,
        change: {
          ...change,
          linked: false,
          title: change.title ?? titles.get(key) ?? null,
        },
      },
    ];
  });
}
