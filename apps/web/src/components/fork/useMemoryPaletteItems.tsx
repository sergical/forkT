import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { useGT } from "gt-react";
import { BookMarkedIcon } from "lucide-react";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { forkMemory } from "../../state/forkMemory";
import { useDebouncedValue } from "../../state/queries";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { useEnvironmentLookups } from "../CommandPaletteLookups";
import { memoryPaletteEntries, type MemoryPaletteEntry } from "./memories.logic";

const SEARCH_DEBOUNCE_MS = 200;
const EMPTY = Atom.make<ReadonlyArray<MemorySearchResult>>([]);

interface MemorySearchResult {
  readonly environmentId: EnvironmentId;
  readonly result: Atom.Type<ReturnType<typeof forkMemory.index>>;
}

// One index search per connected environment; each covers every scope there.
const searchAcrossEnvironments = Atom.family((key: string) =>
  Atom.make((get): ReadonlyArray<MemorySearchResult> => {
    const { environmentIds, query } = JSON.parse(key) as {
      environmentIds: ReadonlyArray<EnvironmentId>;
      query: string;
    };
    return environmentIds.map((environmentId) => ({
      environmentId,
      result: get(forkMemory.index({ environmentId, input: { query } })),
    }));
  }),
);

/** Saved memories whose title or text match a typed query. Empty for an empty query. */
export function useMemoryPaletteItems(query: string): CommandPaletteActionItem[] {
  const gt = useGT();
  const navigate = useNavigate();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const { projectEnvironmentLocationById } = useEnvironmentLookups();
  const normalized = query.trim().slice(0, 500);
  const debounced = useDebouncedValue(normalized, SEARCH_DEBOUNCE_MS);
  const environmentIds = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId);
  const settled =
    normalized.length >= 2 && normalized === debounced && environmentIds.length > 0
      ? debounced
      : null;
  const results = useAtomValue(
    settled === null
      ? EMPTY
      : searchAcrossEnvironments(JSON.stringify({ environmentIds, query: settled })),
  );
  const ready = results.every(({ result }) => !result.waiting);
  const found =
    settled === null || !ready
      ? null
      : memoryPaletteEntries({
          results: results.map(({ environmentId, result }) => ({
            environmentId,
            entries: AsyncResult.getOrElse(result, () => []),
            projects: projects.filter((project) => project.environmentId === environmentId),
            ...(environments.length > 1 && projectEnvironmentLocationById.has(environmentId)
              ? { environmentLabel: projectEnvironmentLocationById.get(environmentId)!.label }
              : {}),
          })),
          personalLabel: gt("Personal"),
          mainCoordinatorLabel: gt("Main coordinator"),
        });
  // Earlier results stay while the next search settles, so the group does not blink per key.
  const [shown, setShown] = useState<ReadonlyArray<MemoryPaletteEntry>>([]);
  if (found !== null && found !== shown && !sameEntries(found, shown)) setShown(found);
  const visible = normalized.length < 2 ? [] : (found ?? shown);
  return visible.map((entry) => ({
    kind: "action",
    value: entry.value,
    searchTerms: [entry.title],
    title: entry.title,
    description: entry.scopeLabel,
    icon: <BookMarkedIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/settings/memories", search: entry.search });
    },
  }));
}

function sameEntries(
  left: ReadonlyArray<MemoryPaletteEntry>,
  right: ReadonlyArray<MemoryPaletteEntry>,
) {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.value === right[index]?.value &&
        entry.title === right[index]?.title &&
        entry.scopeLabel === right[index]?.scopeLabel,
    )
  );
}
