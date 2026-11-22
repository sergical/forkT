import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { forkRoutingUsageSnapshot, recommendForkRoute } from "./forkCoordinatorRouting.ts";

const projectId = ProjectId.make("routing-project");
const now = Date.parse("2026-11-22T12:00:00Z");
const checkedAt = "2026-11-22T11:59:00Z";
const resetsAt = "2026-11-25T22:00:00Z";
const codex = ProviderInstanceId.make("codex");
const spareCodex = ProviderInstanceId.make("spare-codex");
const claude = ProviderInstanceId.make("claudeAgent");
const spareClaude = ProviderInstanceId.make("claudeAgent-work");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const claudeAlias = ProviderDriverKind.make("claude");
const codexDriver = ProviderDriverKind.make("codex");
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [spareClaude]: { driver: claudeDriver, config: {}, enabled: true },
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
  driver:
    selection.instanceId === claude || selection.instanceId === spareClaude
      ? claudeDriver
      : codexDriver,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: {
    status: "authenticated",
    label: selection.model === fable.model ? "Claude Ultra" : "ChatGPT Pro 200",
  },
  checkedAt: sampledAt,
  models: [{ slug: selection.model, name: selection.model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...(windows === undefined ? {} : { usageLimits: { checkedAt: sampledAt, windows } }),
});

const weekly = (id: string, usedPercent: number): ServerProviderUsageWindow => ({
  id,
  label: id === "seven_day_fable" ? "Weekly · Fable" : "Weekly",
  kind: "weekly",
  usedPercent,
  resetsAt,
});

describe("fork subscription routing", () => {
  it.each([claudeAlias, claudeDriver])(
    "excludes all Claude accounts with policy driver %s",
    (driver) => {
      const windows = [weekly("seven_day", 96), weekly("seven_day_fable", 77)];
      const accounts = [
        provider(fable, windows),
        provider({ ...fable, instanceId: spareClaude }, windows),
      ];
      const input = {
        providers: [...accounts, provider(sol, [weekly("secondary", 51)])],
        settings: {
          ...settings,
          forkCoordinatorRouting: { excludedDrivers: [driver], excludedInstances: [] },
        },
        projectId,
        now,
      };
      for (const account of accounts) {
        expect(forkRoutingUsageSnapshot({ ...input, provider: account })).toMatchObject({
          state: "excluded",
          planLabel: "Claude Ultra",
          windows: [
            { label: "Weekly", remainingPercent: 4, resetsAt },
            { label: "Weekly · Fable", modelScope: "Fable", remainingPercent: 23, resetsAt },
          ],
        });
      }
      expect(recommendForkRoute(input).selection).toEqual(sol);
      expect(
        recommendForkRoute({ ...input, target: { driverKind: claudeDriver } }).selection,
      ).toBeNull();
    },
  );

  it("matches the legacy target alias to a configured Claude account", () => {
    const windows = [weekly("seven_day", 96), weekly("seven_day_fable", 77)];
    expect(
      recommendForkRoute({
        providers: [provider({ ...fable, instanceId: spareClaude }, windows)],
        settings,
        projectId,
        now,
        target: { driverKind: claudeAlias, model: fable.model },
      }).selection,
    ).toEqual({ ...fable, instanceId: spareClaude });
  });

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
