import {
  forkRoutingDriverKind,
  isForkCoordinatorThreadId,
  isForkRoutingDriverExcluded,
  isProviderAvailable,
  ThreadId,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpProviderCapability,
  type OrchestratorMcpTaskRole,
  type OrchestratorMcpTarget,
  type ProjectId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  exhaustedUsageWindow,
  remainingPercent,
  resolveNewThreadModelSelection,
} from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { claudeUsageWindowModelScope, windowLimitsModel } from "../provider/claudeUsageLimits.ts";

type RoutingUsage = NonNullable<OrchestratorMcpProviderCapability["routingUsage"]>;
type RoutingEligibility = Pick<RoutingUsage, "state" | "checkedAt" | "limitingWindow">;
type RoutingRequest = {
  readonly role?: OrchestratorMcpTaskRole | undefined;
  readonly highJudgment?: boolean | undefined;
  readonly target?: OrchestratorMcpTarget | undefined;
};

const FORK_ROUTING_UNAVAILABLE =
  "No eligible subscription for fork work. Check provider sign-in, enabled models, and allowance in Usage, or wait for the displayed reset.";

/** Mark standalone threads started by a coordinator so their own delegations remain scoped. */
export const forkRoutedThreadId = (id: ThreadId): ThreadId => ThreadId.make(`fork:work:${id}`);

export const isForkRoutingThreadId = (id: ThreadId): boolean =>
  isForkCoordinatorThreadId(id) || id.startsWith("fork:work:") || id.startsWith("fork:dream:");

export const isForkRoutingThread = (
  thread: Pick<OrchestrationV2ThreadProjection["thread"], "id" | "lineage">,
): boolean =>
  isForkRoutingThreadId(thread.id) ||
  (thread.lineage?.relationshipToParent === "subagent" &&
    isForkRoutingThreadId(thread.lineage.rootThreadId));

function routingWindow(provider: ServerProvider, window: ServerProviderUsageWindow) {
  const modelScope =
    forkRoutingDriverKind(provider.driver) === "claudeAgent"
      ? claudeUsageWindowModelScope(window)
      : undefined;
  return {
    label: window.label,
    remainingPercent: remainingPercent(window),
    resetsAt: window.resetsAt ?? null,
    ...(window.modelIds === undefined ? {} : { modelIds: window.modelIds }),
    ...(window.providerIds === undefined ? {} : { providerIds: window.providerIds }),
    ...(modelScope === undefined ? {} : { modelScope }),
  };
}

function modelRouteRank(provider: ServerProvider, model: string, highJudgment: boolean) {
  if (provider.driver === "codex") {
    if (highJudgment) return /(?:^|-)astra(?:-|$)/i.test(model) ? 0 : 2;
    return /(?:^|-)sol(?:-|$)/i.test(model) ? 0 : 2;
  }
  if (highJudgment) return /(?:^|-)fable(?:-|$)/i.test(model) ? 0 : 1;
  return /(?:^|-)sonnet(?:-|$)/i.test(model) ? 1 : 3;
}

function applicableUsageWindows(provider: ServerProvider, model?: string) {
  const modelName = provider.models.find(({ slug }) => slug === model)?.name;
  return (provider.usageLimits?.windows ?? []).filter(
    (window) =>
      (model === undefined
        ? window.modelIds === undefined && window.providerIds === undefined
        : (window.modelIds === undefined || window.modelIds.includes(model)) &&
          (window.providerIds === undefined ||
            window.providerIds.includes(model.split("/")[0]!))) &&
      (forkRoutingDriverKind(provider.driver) !== "claudeAgent" ||
        windowLimitsModel(window, model ?? null) ||
        (modelName !== undefined && windowLimitsModel(window, modelName))),
  );
}

/** A positive snapshot stops authorizing launches once it ages out or a reported window resets. */
function forkRoutingEligibility(input: {
  readonly provider: ServerProvider;
  readonly settings: ServerSettings;
  readonly projectId: ProjectId;
  readonly now: number;
  readonly model?: string;
}): RoutingEligibility {
  const { provider, settings, projectId, now, model } = input;
  const limits = provider.usageLimits;
  const checkedAt = limits?.checkedAt ?? null;
  const policy = settings.forkCoordinatorRouting;
  if (
    isForkRoutingDriverExcluded(provider.driver, policy?.excludedDrivers ?? []) ||
    policy?.excludedInstances.includes(provider.instanceId)
  ) {
    return { state: "excluded", checkedAt };
  }
  if (
    (provider.driver !== "codex" && forkRoutingDriverKind(provider.driver) !== "claudeAgent") ||
    !provider.enabled ||
    !provider.installed ||
    !isProviderAvailable(provider) ||
    provider.status === "error" ||
    provider.status === "disabled" ||
    provider.auth.status !== "authenticated" ||
    provider.auth.type === "apiKey" ||
    provider.auth.type === "bedrock" ||
    provider.auth.endpoint !== undefined ||
    !resolveProjectProviderInstanceEnabled(settings, projectId, provider.instanceId)
  ) {
    return { state: "unavailable", checkedAt };
  }
  const windows = applicableUsageWindows(provider, model);
  const exhausted =
    limits === undefined
      ? undefined
      : exhaustedUsageWindow(
          { ...provider, usageLimits: { ...limits, windows } },
          now,
          model ?? provider.models[0]?.slug,
        );
  if (exhausted !== undefined) {
    return { state: "exhausted", checkedAt, limitingWindow: routingWindow(provider, exhausted) };
  }
  const planWindows = windows.filter((window) =>
    provider.driver === "codex"
      ? window.id === "primary" || window.id === "secondary"
      : window.id === "five_hour" || window.id === "seven_day",
  );
  const hasFableMeter =
    forkRoutingDriverKind(provider.driver) !== "claudeAgent" ||
    model === undefined ||
    !/(?:^|-)fable(?:-|$)/i.test(model) ||
    windows.some(
      (window) => window.id.startsWith("seven_day_") || window.modelIds?.includes(model),
    );
  if (
    limits?.unavailable !== undefined ||
    checkedAt === null ||
    planWindows.length === 0 ||
    !hasFableMeter
  ) {
    return { state: "unknown", checkedAt };
  }
  const checkedAtMs = Date.parse(checkedAt);
  const freshFor = Math.max(
    10 * 60_000,
    2 * Duration.toMillis(settings.providerHealthRefreshInterval),
  );
  if (
    !Number.isFinite(checkedAtMs) ||
    checkedAtMs > now ||
    now - checkedAtMs > freshFor ||
    windows.some((window) => window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now)
  ) {
    return { state: "stale", checkedAt };
  }
  const limiting = windows.reduce((least, window) =>
    window.usedPercent > least.usedPercent ? window : least,
  );
  return { state: "available", checkedAt, limitingWindow: routingWindow(provider, limiting) };
}

/** Only cached, provider-reported details appear in the capabilities snapshot, even when excluded. */
export function forkRoutingUsageSnapshot(
  input: Parameters<typeof forkRoutingEligibility>[0],
): RoutingUsage {
  const { provider } = input;
  return {
    ...forkRoutingEligibility(input),
    planLabel: provider.auth.label ?? null,
    windows: (provider.usageLimits?.windows ?? []).map((window) => routingWindow(provider, window)),
  };
}

type ForkRoutingInput = RoutingRequest & {
  readonly settings: ServerSettings;
  readonly projectId: ProjectId;
  readonly providers: readonly ServerProvider[];
  readonly now: number;
  readonly defaultSelection?: ModelSelection | null;
  readonly fallbackSelection?: ModelSelection | null;
};

function matchesRoutingTarget(provider: ServerProvider, target: OrchestratorMcpTarget | undefined) {
  return (
    (target?.providerInstanceId === undefined ||
      target.providerInstanceId === provider.instanceId) &&
    (target?.driverKind === undefined ||
      forkRoutingDriverKind(target.driverKind) === forkRoutingDriverKind(provider.driver))
  );
}

/** Rank only advertised models with verified subscription headroom; explicit targets narrow the pool. */
export function recommendForkRoute(
  input: ForkRoutingInput,
): NonNullable<OrchestratorMcpCapabilitiesResult["routing"]> {
  const { target, providers, defaultSelection, fallbackSelection } = input;
  const highJudgment = input.highJudgment ?? (input.role === "review" || input.role === "design");
  const automatic =
    target?.model === undefined &&
    target?.providerInstanceId === undefined &&
    target?.driverKind === undefined &&
    target?.options === undefined;
  const fallback =
    defaultSelection && fallbackSelection && automatic
      ? resolveNewThreadModelSelection({ ...input, defaultSelection, fallbackSelection }).fallback
      : null;
  const candidates = providers.flatMap((provider) => {
    if (!matchesRoutingTarget(provider, target)) return [];
    return provider.models.flatMap((model, index) => {
      if (model.isCustom && target?.model !== model.slug && defaultSelection?.model !== model.slug)
        return [];
      if (target?.model !== undefined && target.model !== model.slug) return [];
      const selection = { instanceId: provider.instanceId, model: model.slug };
      const usage = forkRoutingEligibility({ ...input, provider, model: model.slug });
      if (usage.state !== "available" || usage.limitingWindow === undefined) return [];
      const matches = (configured: ModelSelection | null | undefined) =>
        configured?.instanceId === selection.instanceId && configured.model === selection.model;
      return [
        {
          selection: matches(defaultSelection)
            ? defaultSelection!
            : fallback !== null && matches(fallbackSelection)
              ? fallbackSelection!
              : selection,
          limitingWindow: usage.limitingWindow,
          rank: modelRouteRank(provider, model.slug, highJudgment),
          configuredFallback: fallback !== null && matches(fallbackSelection),
          preferred: matches(defaultSelection),
          index,
        },
      ];
    });
  });
  candidates.sort(
    (a, b) =>
      Number(b.limitingWindow.remainingPercent >= 20) -
        Number(a.limitingWindow.remainingPercent >= 20) ||
      Number(b.configuredFallback) - Number(a.configuredFallback) ||
      a.rank - b.rank ||
      b.limitingWindow.remainingPercent - a.limitingWindow.remainingPercent ||
      Number(b.preferred) - Number(a.preferred) ||
      a.index - b.index,
  );
  const best = candidates[0];
  if (best === undefined) {
    return {
      selection: null,
      reason: automatic
        ? FORK_ROUTING_UNAVAILABLE
        : "Requested fork target is excluded, unavailable, unverified, or out of allowance. Check orchestrator_capabilities and Usage, then choose an eligible target.",
    };
  }
  const basis = !automatic
    ? "Requested target"
    : best.configuredFallback
      ? "Configured fallback"
      : highJudgment
        ? "High-judgment work"
        : "Routine work";
  return {
    selection: best.selection,
    limitingWindow: best.limitingWindow,
    reason: `${basis}. ${best.limitingWindow.remainingPercent}% left in the tightest reported window.`,
  };
}

/** Refresh only eligible subscription candidates whose cached data cannot authorize a launch. */
export const refreshForkRoutingProviders = Effect.fn("ForkCoordinatorRouting.refreshProviders")(
  function* (
    registry: ProviderRegistry.ProviderRegistry["Service"],
    input: Omit<ForkRoutingInput, "now">,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const refresh = input.providers.filter((provider) => {
      if (!matchesRoutingTarget(provider, input.target)) return false;
      const usage = forkRoutingEligibility({
        ...input,
        provider,
        now,
        ...(input.target?.model === undefined ? {} : { model: input.target.model }),
      });
      return usage.state === "stale" || usage.state === "unknown";
    });
    if (refresh.length === 0) return input.providers;
    yield* Effect.forEach(refresh, (provider) => registry.refreshInstance(provider.instanceId), {
      concurrency: 3,
      discard: true,
    });
    return yield* registry.getProviders;
  },
);

/** Check the exact pinned model again before a queued run may reach a provider. */
export const verifyForkDispatch = Effect.fn("ForkCoordinatorRouting.verifyDispatch")(function* (
  registry: ProviderRegistry.ProviderRegistry["Service"],
  settings: ServerSettings,
  projectId: ProjectId,
  selection: ModelSelection,
) {
  const input = {
    settings,
    projectId,
    providers: yield* registry.getProviders,
    defaultSelection: selection,
    target: { providerInstanceId: selection.instanceId, model: selection.model },
  };
  return recommendForkRoute({
    ...input,
    providers: yield* refreshForkRoutingProviders(registry, input),
    now: yield* Clock.currentTimeMillis,
  });
});
