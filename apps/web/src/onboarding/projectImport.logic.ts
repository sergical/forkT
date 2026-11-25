import {
  findProjectByPath,
  normalizeProjectPathForComparison,
} from "@t3tools/client-runtime/state/projects";
import type { AgentSessionProjectCandidate, EnvironmentId, ProjectId } from "@t3tools/contracts";

export const RECENT_PROJECT_WINDOW_DAYS = 30;
const RECENT_PROJECT_WINDOW_MS = RECENT_PROJECT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const DEFAULT_SELECTION_MIN_THREADS = 3;

/**
 * Threads an import brings: the server counts those in the import's own 30-day window.
 * Servers predating that count report only the all-time total.
 */
export function importableThreadCount(
  candidate: Pick<AgentSessionProjectCandidate, "threadCount" | "recentThreadCount">,
): number {
  return candidate.recentThreadCount ?? candidate.threadCount;
}

/** Treat candidates missing git as repositories for servers predating git scans. */
export function partitionOnboardingProjects<T extends AgentSessionProjectCandidate>(
  candidates: ReadonlyArray<T>,
  now = Date.now(),
) {
  const cutoff = now - RECENT_PROJECT_WINDOW_MS;

  return {
    available: candidates,
    recent: candidates.filter((candidate) => {
      if (candidate.temporary || candidate.git === null) return false;
      if (importableThreadCount(candidate) < DEFAULT_SELECTION_MIN_THREADS) return false;
      if (candidate.lastActiveAt === null) return false;
      const lastActiveAt = Date.parse(candidate.lastActiveAt);
      return lastActiveAt >= cutoff && lastActiveAt <= now;
    }),
  };
}

/**
 * The onboarding list: the default picks first, every other new project behind "Show more".
 * With no default picks there is nothing to hide, so the rest shows, unpicked.
 */
export function splitOnboardingProjectList<T extends { readonly key: string }>(input: {
  readonly available: ReadonlyArray<T>;
  readonly recent: ReadonlyArray<T>;
  readonly isNew: (candidate: T) => boolean;
}) {
  const recentKeys = new Set(input.recent.map((candidate) => candidate.key));
  const rest = input.available.filter(
    (candidate) => input.isNew(candidate) && !recentKeys.has(candidate.key),
  );
  return input.recent.length === 0
    ? { shown: rest, more: [] as T[], picked: new Set<string>() }
    : { shown: [...input.recent], more: rest, picked: recentKeys };
}

export interface OnboardingProjectGroup<T> {
  readonly key: string;
  readonly label: string;
  readonly repository: string | null;
  readonly candidates: ReadonlyArray<T>;
  readonly threadCount: number;
  readonly lastActiveAt: string | null;
}

function latestActivity(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

export function groupOnboardingProjects<
  T extends Pick<
    AgentSessionProjectCandidate,
    "path" | "title" | "git" | "threadCount" | "recentThreadCount" | "lastActiveAt"
  >,
>(candidates: ReadonlyArray<T>) {
  const groups = new Map<string, OnboardingProjectGroup<T> & { candidates: Array<T> }>();
  const other: Array<T> = [];

  for (const candidate of candidates) {
    if (candidate.git === null) {
      other.push(candidate);
      continue;
    }
    const git = candidate.git ?? { remoteKey: null, repository: null };
    const key = git.remoteKey === null ? `path:${candidate.path}` : `remote:${git.remoteKey}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        label: git.repository ?? candidate.title,
        repository: git.repository,
        candidates: [candidate],
        threadCount: importableThreadCount(candidate),
        lastActiveAt: candidate.lastActiveAt,
      });
      continue;
    }
    existing.candidates.push(candidate);
    groups.set(key, {
      ...existing,
      threadCount: existing.threadCount + importableThreadCount(candidate),
      lastActiveAt: latestActivity(existing.lastActiveAt, candidate.lastActiveAt),
    });
  }

  const repositories = [...groups.values()].sort((left, right) => {
    if (left.lastActiveAt === right.lastActiveAt) return left.label.localeCompare(right.label);
    if (left.lastActiveAt === null) return 1;
    if (right.lastActiveAt === null) return -1;
    return right.lastActiveAt.localeCompare(left.lastActiveAt);
  });

  return { repositories, other };
}

/** Use the server's project match before the client snapshot, which can lag behind the scan. */
export function resolveOnboardingProjectId(
  projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
  }>,
  environmentId: EnvironmentId,
  candidate: Pick<AgentSessionProjectCandidate, "path" | "projectId">,
): ProjectId | null {
  if (candidate.projectId !== undefined) return candidate.projectId;
  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const currentRootMatch = findProjectByPath(environmentProjects, candidate.path);
  if (currentRootMatch !== undefined) return currentRootMatch.id;
  return null;
}

/**
 * Whether a candidate is not a project yet, by the same rules as `resolveOnboardingProjectId`.
 * It reads the project list once, so a long candidate list costs one pass, not one per candidate.
 */
export function isNewOnboardingProject(
  projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
  }>,
) {
  const roots = new Set(
    projects.map(
      (project) =>
        `${project.environmentId}\u0000${normalizeProjectPathForComparison(project.workspaceRoot)}`,
    ),
  );
  return (
    environmentId: EnvironmentId,
    candidate: Pick<AgentSessionProjectCandidate, "path" | "projectId">,
  ) => {
    if (candidate.projectId !== undefined) return false;
    const path = normalizeProjectPathForComparison(candidate.path);
    return path.length === 0 || !roots.has(`${environmentId}\u0000${path}`);
  };
}

export function resolveOnboardingLandingProject<T>(
  selection: ReadonlyArray<string>,
  projectsWithImportedHistory: ReadonlyMap<string, T>,
  completedProjects: ReadonlyMap<string, T>,
): T | undefined {
  for (const path of selection) {
    const project = projectsWithImportedHistory.get(path);
    if (project !== undefined) return project;
  }
  for (const path of selection) {
    const project = completedProjects.get(path);
    if (project !== undefined) return project;
  }
  return undefined;
}

export function splitOnboardingProjectPath(path: string): {
  readonly name: string;
  readonly parent: string;
} {
  if (/^[A-Za-z]:[\\/]+$/.test(path) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]*$/.test(path)) {
    return { name: path, parent: "" };
  }
  const trimmed = path.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (trimmed.length === 0) return { name: path, parent: "" };
  if (separatorIndex < 0) return { name: trimmed, parent: "" };
  return { name: trimmed.slice(separatorIndex + 1), parent: trimmed.slice(0, separatorIndex + 1) };
}

export function onboardingProjectKey(environmentId: EnvironmentId, path: string): string {
  return JSON.stringify([environmentId, path]);
}
