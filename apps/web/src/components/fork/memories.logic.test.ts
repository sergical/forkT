import { EnvironmentId, ProjectId, type ForkMemoryIndexEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  memoryChangeFromToolItem,
  memoryPaletteEntries,
  memoryRefFromSearch,
  settleMemoryChanges,
  validateMemoriesSearch,
} from "./memories.logic";

const environmentId = EnvironmentId.make("env-local");
const projectId = ProjectId.make("project-app");
const archivedId = ProjectId.make("project-old");

const entry = (scope: ProjectId | null, id: string, title: string): ForkMemoryIndexEntry => ({
  projectId: scope,
  id,
  kind: "preference",
  title,
  revision: 1,
  updatedAt: "2026-11-20T10:00:00.000Z",
});

describe("memoryPaletteEntries", () => {
  it("opens each found memory in its own scope and names that scope", () => {
    const found = memoryPaletteEntries({
      personalLabel: "Personal",
      results: [
        {
          environmentId,
          entries: [
            entry(null, "hands-on", "How hands-on to be"),
            entry(projectId, "hands-on", "How hands-on to be"),
            entry(archivedId, "old", "How hands-on to be"),
          ],
          projects: [
            { id: projectId, title: "t3code" },
            { id: archivedId, title: "Old app", archivedAt: "2026-11-01T00:00:00.000Z" },
          ],
        },
      ],
    });
    expect(found.map(({ title, scopeLabel }) => [title, scopeLabel])).toEqual([
      ["How hands-on to be", "Personal"],
      ["How hands-on to be", "t3code"],
    ]);
    expect(new Set(found.map((item) => item.value)).size).toBe(2);
    // The route search a pasted link carries opens the same memory.
    const reopened = found.map((item) =>
      memoryRefFromSearch(
        validateMemoriesSearch(Object.fromEntries(new URLSearchParams({ ...item.search }))),
      ),
    );
    expect(reopened).toEqual([
      { environmentId, projectId: null, id: "hands-on" },
      { environmentId, projectId, id: "hands-on" },
    ]);
  });
});

describe("memory changes in the timeline", () => {
  const save = (
    toolName: string,
    input: Record<string, unknown>,
    status: "completed" | "failed" = "completed",
    output: unknown = {},
  ) => memoryChangeFromToolItem({ toolName, status, input, output });
  const saveInput = {
    projectId: null,
    id: "hands-on",
    commandId: "cmd-1",
    expectedRevision: 0,
    title: "How hands-on to be",
    body: "Decide in my place.",
  };

  it("shows successful saves and updates, and hides failures, reads and repeated retries", () => {
    const saved = save("mcp__t3-code__t3_memory_save", saveInput);
    expect(saved).toMatchObject({ action: "saved", title: "How hands-on to be", linked: true });
    expect(
      save("t3-code.t3_memory_save", { ...saveInput, commandId: "cmd-2", expectedRevision: 1 }),
    ).toMatchObject({ action: "updated", linked: true });
    expect(save("mcp__t3-code__t3_memory_save", saveInput, "failed")).toBeNull();
    expect(
      save("mcp__t3-code__t3_memory_save", saveInput, "completed", { isError: true }),
    ).toBeNull();
    expect(save("mcp__t3-code__t3_memory_search", { projectId: null, query: "" })).toBeNull();

    const retried = settleMemoryChanges([
      { id: "a", change: saved! },
      { id: "b", change: save("mcp__t3-code__t3_memory_save", saveInput)! },
    ]);
    expect(retried.map((line) => line.id)).toEqual(["a"]);
  });

  it("shows a removal without a link and stops earlier lines from linking", () => {
    const removed = save("mcp__t3-code__t3_memory_forget", {
      projectId: null,
      id: "hands-on",
      expectedRevision: 1,
    });
    expect(removed).toMatchObject({ action: "removed", title: null, linked: false });
    const lines = settleMemoryChanges([
      { id: "a", change: save("mcp__t3-code__t3_memory_save", saveInput)! },
      { id: "b", change: removed! },
    ]);
    expect(lines.map(({ change }) => [change.action, change.title, change.linked])).toEqual([
      ["saved", "How hands-on to be", false],
      ["removed", "How hands-on to be", false],
    ]);
  });
});
