import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { recommendForkRoute } from "./forkCoordinatorRouting.ts";

const projectId = ProjectId.make("routing-project");
const now = Date.parse("2026-11-22T12:00:00Z");
const checkedAt = "2026-11-22T11:59:00Z";
const resetsAt = "2026-11-25T22:00:00Z";
const codex = ProviderInstanceId.make("codex");
const spareCodex = ProviderInstanceId.make("spare-codex");
const claude = ProviderInstanceId.make("claudeAgent");
const codexDriver = ProviderDriverKind.make("codex");
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [spareCodex]: { driver: codexDriver, config: {}, enabled: true },
  },
  forkCoordinatorRouting: { excludedDrivers: [], excludedInstances: [] },
};
const fable = { instanceId: claude, model: "claude-fable-5-2" };
const sol = { instanceId: codex, model: "gpt-6-2-sol" };
const spare = { ...sol, instanceId: spareCodex };

const provider = (
  selection: typeof fable,
  windows?: readonly ServerProviderUsageWindow[],
  sampledAt = checkedAt,
): ServerProvider => ({
  instanceId: selection.instanceId,
  driver: selection.instanceId === claude ? ProviderDriverKind.make("claude") : codexDriver,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: sampledAt,
  models: [{ slug: selection.model, name: selection.model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...(windows === undefined ? {} : { usageLimits: { checkedAt: sampledAt, windows } }),
});

const weekly = (id: string, usedPercent: number): ServerProviderUsageWindow => ({
  id,
  label: id,
  kind: "weekly",
  usedPercent,
  resetsAt,
});

describe("fork subscription routing", () => {
  it.each([
    ["shared Claude exhausted", [weekly("seven_day", 100), weekly("seven_day_fable", 77)], null],
    ["Fable exhausted", [weekly("seven_day", 46), weekly("seven_day_fable", 100)], null],
    ["Fable meter missing", [weekly("seven_day", 46)], null],
    ["both windows open", [weekly("seven_day", 96), weekly("seven_day_fable", 77)], 4],
  ] as const)("checks the requested Fable account when %s", (_, windows, remaining) => {
    const result = recommendForkRoute({
      providers: [provider(fable, windows), provider(sol, [weekly("secondary", 46)])],
      settings,
      projectId,
      now,
      target: { providerInstanceId: claude, model: fable.model },
    });
    expect(result.selection).toEqual(remaining === null ? null : fable);
    expect(result.limitingWindow?.remainingPercent ?? null).toBe(remaining);
  });

  it.each([
    ["exhausted", provider(sol, [weekly("secondary", 100)])],
    ["missing usage", provider(sol)],
    ["stale", provider(sol, [weekly("secondary", 46)], "2026-11-22T09:00:00Z")],
    ["past reset", provider(sol, [{ ...weekly("secondary", 100), resetsAt: checkedAt }])],
    ["missing model", { ...provider(sol, [weekly("secondary", 46)]), models: [] }],
  ] as const)("uses another account for automatic routing when the primary is %s", (_, primary) => {
    const input = {
      settings,
      projectId,
      now,
      providers: [primary, provider(spare, [weekly("secondary", 46)])],
      defaultSelection: sol,
      fallbackSelection: spare,
    };
    expect(recommendForkRoute(input).selection).toEqual(spare);
    expect(
      recommendForkRoute({
        ...input,
        target: { providerInstanceId: codex, model: sol.model },
      }).selection,
    ).toBeNull();
  });

  it("rejects the configured fallback when its instance is excluded", () => {
    expect(
      recommendForkRoute({
        providers: [
          provider(sol, [weekly("secondary", 100)]),
          provider(spare, [weekly("secondary", 46)]),
        ],
        settings: {
          ...settings,
          forkCoordinatorRouting: { excludedDrivers: [], excludedInstances: [spareCodex] },
        },
        projectId,
        now,
        defaultSelection: sol,
        fallbackSelection: spare,
      }).selection,
    ).toBeNull();
  });
});
