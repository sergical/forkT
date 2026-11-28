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
  type ProviderInstanceId,
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
import * as Option from "effect/Option";
import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { claudeUsageWindowModelScope, windowLimitsModel } from "../provider/claudeUsageLimits.ts";

type RoutingUsage = NonNullable<OrchestratorMcpProviderCapability["routingUsage"]>;
type RoutingEligibility = Pick<RoutingUsage, "state" | "checkedAt" | "limitingWindow"> & {
  readonly reason?: string;
  readonly refresh?: "provider" | "usage" | undefined;
};
type RoutingRequest = {
  readonly role?: OrchestratorMcpTaskRole | undefined;
  readonly highJudgment?: boolean | undefined;
  readonly target?: OrchestratorMcpTarget | undefined;
};

const usageSettings = "Settings → Usage → Limits";
const providerSettings = "Settings → Providers";
const nonSubscriptionAuth: ReadonlyMap<string, string> = new Map([
  ["apiKey", "an API key"],
  ["bedrock", "Amazon Bedrock"],
  ["externalProvider", "an external API provider"],
  ["customEndpoint", "a custom endpoint"],
]);
const subscriptionDriver = (driver: string) =>
  driver === "codex" || forkRoutingDriverKind(driver) === "claudeAgent";

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

function accountRestriction(
  settings: ServerSettings,
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  driver: string | undefined,
) {
  const policy = settings.forkCoordinatorRouting;
  if (driver && isForkRoutingDriverExcluded(driver, policy?.excludedDrivers ?? [])) {
    return {
      state: "excluded",
      reason: "This provider is excluded from coordinator routing. Choose an allowed subscription.",
    } as const;
  }
  if (policy?.excludedInstances.includes(instanceId)) {
    return {
      state: "excluded",
      reason: "This account is excluded from coordinator routing. Choose an allowed subscription.",
    } as const;
  }
  if (driver && !subscriptionDriver(driver)) {
    return {
      state: "unavailable",
      reason:
        "Coordinator routing supports Codex and Claude subscriptions. Choose a supported account.",
    } as const;
  }
  if (driver && !resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)) {
    const projectDisabled =
      settings.projectSettingsOverrides[projectId]?.providerInstances?.[instanceId]?.enabled ===
      false;
    return {
      state: "unavailable",
      reason: projectDisabled
        ? "This account is disabled for this project. Enable it in project settings or choose another account."
        : `This account is disabled. Enable it in ${providerSettings} or choose another account.`,
    } as const;
  }
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
  const blocked = (
    state: Exclude<RoutingEligibility["state"], "available">,
    reason: string,
    refresh?: RoutingEligibility["refresh"],
  ): RoutingEligibility => ({ state, reason, checkedAt, refresh });
  const restriction = accountRestriction(settings, projectId, provider.instanceId, provider.driver);
  if (restriction) return { ...restriction, checkedAt };
  if (!isProviderAvailable(provider)) {
    return blocked(
      "unavailable",
      `The server could not load this provider instance. Check its configuration in ${providerSettings}, then retry.`,
      "provider",
    );
  }
  if (!provider.enabled || provider.status === "disabled") {
    return blocked(
      "unavailable",
      `The provider reports it is disabled. Check the account in ${providerSettings}, then retry.`,
    );
  }
  const billingRoute = provider.auth.endpoint
    ? "a custom endpoint"
    : nonSubscriptionAuth.get(provider.auth.type ?? "");
  if (billingRoute) {
    return blocked(
      "unavailable",
      `This account uses ${billingRoute}. Choose an account signed in with a subscription.`,
    );
  }
  if (!provider.installed) {
    return blocked(
      "unavailable",
      `The server could not find this provider's CLI. Check its installation and binary path in ${providerSettings}, then retry.`,
      "provider",
    );
  }
  if (provider.auth.status === "unauthenticated") {
    return blocked(
      "unavailable",
      `This account is signed out. Sign in through ${providerSettings}, then retry.`,
      "provider",
    );
  }
  if (provider.status === "error") {
    return blocked(
      "unavailable",
      `The provider health check failed. Check the account in ${providerSettings}, then retry.`,
      "provider",
    );
  }
  if (provider.auth.status !== "authenticated") {
    return blocked(
      "unavailable",
      `The provider could not verify sign-in. Check the account in ${providerSettings}, then retry.`,
      "provider",
    );
  }
  const update = model && provider.updateRequiredModels?.find(({ slug }) => slug === model);
  if (update && !provider.models.some(({ slug }) => slug === model)) {
    return blocked(
      "unavailable",
      `This model requires provider version ${update.minVersion} or later. Update the CLI in ${providerSettings} or choose a listed model.`,
      "provider",
    );
  }
  if (provider.models.length === 0) {
    return blocked(
      "unavailable",
      `The provider reported no models. Refresh its model list in ${providerSettings}, then retry.`,
      "provider",
    );
  }
  if (model !== undefined && !provider.models.some(({ slug }) => slug === model)) {
    return blocked(
      "unavailable",
      `This model is missing from the account's model list. Refresh models in ${providerSettings} or choose a listed model.`,
      "provider",
    );
  }
  const windows = applicableUsageWindows(provider, model);
  const hasPlanWindow = windows.some((window) =>
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
  const usageCheck = checkedAt === null ? "" : ` Allowance was last checked at ${checkedAt}.`;
  if (limits?.unavailable?.reason === "unsupported") {
    return blocked(
      "unknown",
      `The provider could not verify subscription allowance for this configuration. Check its account and endpoint in ${providerSettings}.${usageCheck}`,
      "provider",
    );
  }
  if (
    limits === undefined ||
    limits.unavailable !== undefined ||
    checkedAt === null ||
    !hasPlanWindow ||
    !hasFableMeter
  ) {
    const missing = limits?.unavailable
      ? "The allowance check failed."
      : !hasFableMeter
        ? "The provider did not report this model's allowance."
        : "The provider did not report a shared subscription allowance.";
    return blocked(
      "unknown",
      `${missing}${usageCheck} Open ${usageSettings}, refresh the allowance, and retry.`,
      "usage",
    );
  }
  const checkedAtMs = Date.parse(checkedAt);
  const freshFor = Math.max(
    10 * 60_000,
    2 * Duration.toMillis(settings.providerHealthRefreshInterval),
  );
  if (!Number.isFinite(checkedAtMs) || checkedAtMs > now || now - checkedAtMs > freshFor) {
    return blocked(
      "stale",
      `The last allowance report is out of date (${checkedAt}). Open ${usageSettings}, refresh the allowance, and retry.`,
      "usage",
    );
  }
  const exhausted = exhaustedUsageWindow(
    { ...provider, usageLimits: { ...limits, windows } },
    now,
    model ?? provider.models[0]?.slug,
  );
  if (exhausted !== undefined) {
    const reset = exhausted.resetsAt ? ` The reported reset is ${exhausted.resetsAt}.` : "";
    return {
      ...blocked(
        "exhausted",
        `The last report showed 0% left in ${exhausted.label} at ${checkedAt}.${reset} Retry when allowance is available in ${usageSettings}, or choose another eligible subscription.`,
        "usage",
      ),
      limitingWindow: routingWindow(provider, exhausted),
    };
  }
  // Seat-based Codex credit caps only apply after the included plan, which routing never exceeds.
  const includedWindows =
    provider.driver === "codex" ? windows.filter((window) => window.id !== "individual") : windows;
  const reset = includedWindows.find(
    (window) => window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now,
  );
  if (reset) {
    return blocked(
      "stale",
      `The reported ${reset.label} reset (${reset.resetsAt}) has passed. Current allowance is unverified. Open ${usageSettings}, refresh the allowance, and retry.`,
      "usage",
    );
  }
  const limiting = includedWindows.reduce((least, window) =>
    window.usedPercent > least.usedPercent ? window : least,
  );
  return { state: "available", checkedAt, limitingWindow: routingWindow(provider, limiting) };
}

/** Only cached, provider-reported details appear in the capabilities snapshot, even when excluded. */
export function forkRoutingUsageSnapshot(
  input: Parameters<typeof forkRoutingEligibility>[0],
): RoutingUsage {
  const { provider } = input;
  const { state, checkedAt, limitingWindow } = forkRoutingEligibility(input);
  return {
    state,
    checkedAt,
    ...(limitingWindow && { limitingWindow }),
    planLabel: provider.auth.label ?? null,
    windows: (provider.usageLimits?.windows ?? []).map((window) => routingWindow(provider, window)),
  };
}

type ForkRoutingInput = RoutingRequest & {
  readonly refreshTimedOut?: boolean;
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

function routingModels(input: ForkRoutingInput, provider: ServerProvider) {
  return provider.models.filter((model) =>
    input.target?.model !== undefined
      ? model.slug === input.target.model
      : !model.isCustom || model.slug === input.defaultSelection?.model,
  );
}

function configuredRoutingDriver(
  input: Pick<ForkRoutingInput, "settings">,
  id: ProviderInstanceId,
) {
  return input.settings.providerInstances[id]?.driver ?? (subscriptionDriver(id) ? id : undefined);
}

function describeRefusal(input: ForkRoutingInput) {
  const { providers, target, settings } = input;
  const matching = providers.filter(
    (provider) =>
      matchesRoutingTarget(provider, target) &&
      (subscriptionDriver(provider.driver) ||
        target?.providerInstanceId !== undefined ||
        target?.driverKind !== undefined),
  );
  const preferred = input.defaultSelection?.instanceId;
  const accounts = matching.toSorted(
    (a, b) => Number(b.instanceId === preferred) - Number(a.instanceId === preferred),
  );
  const reasons = accounts.slice(0, 3).map((provider) => {
    const models = routingModels(input, provider);
    const model =
      target?.model ??
      models.find(
        ({ slug }) =>
          provider.instanceId === input.defaultSelection?.instanceId &&
          slug === input.defaultSelection.model,
      )?.slug ??
      models[0]?.slug;
    const usage = forkRoutingEligibility({
      ...input,
      provider,
      ...(model !== undefined && { model }),
    });
    const name =
      provider.displayName && provider.displayName !== provider.instanceId
        ? `${provider.displayName} (${provider.instanceId})`
        : provider.instanceId;
    const reason =
      usage.reason ?? "Only custom models were reported. Select a specific model and retry.";
    const lastCheck =
      usage.refresh === "provider"
        ? ` The provider was last checked at ${provider.checkedAt}.`
        : "";
    return `${name}${model === undefined ? "" : " / " + model}\n${reason}${lastCheck}`;
  });
  if (reasons.length > 0) return reasons.join("\n\n");
  const instance = target?.providerInstanceId;
  const label = [instance, target?.driverKind, target?.model].filter(Boolean).join(" / ");
  const prefix = label ? `${label}\n` : "";
  if (instance) {
    const driver = configuredRoutingDriver(input, instance);
    const restriction = accountRestriction(settings, input.projectId, instance, driver);
    if (restriction) return prefix + restriction.reason;
    if (
      driver &&
      target?.driverKind &&
      forkRoutingDriverKind(driver) !== forkRoutingDriverKind(target.driverKind)
    ) {
      return `${prefix}This account uses the ${driver} provider. Choose a matching account.`;
    }
    return `${prefix}The server has no matching provider available for this account. Check the account in ${providerSettings}, then retry.`;
  }
  if (
    target?.driverKind &&
    isForkRoutingDriverExcluded(
      target.driverKind,
      settings.forkCoordinatorRouting?.excludedDrivers ?? [],
    )
  ) {
    return `${prefix}This provider is excluded from coordinator routing. Choose an allowed subscription.`;
  }
  return `${prefix}The server has no matching subscription provider. Check ${providerSettings}, then retry.`;
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
    return routingModels(input, provider).flatMap((model, index) => {
      const effort =
        automatic && highJudgment && provider.driver === "codex"
          ? model.capabilities?.optionDescriptors?.find(
              (descriptor) =>
                descriptor.id === "reasoningEffort" &&
                descriptor.type === "select" &&
                descriptor.options.some((option) => option.id === "xhigh"),
            )
          : undefined;
      const selection: ModelSelection = { instanceId: provider.instanceId, model: model.slug };
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
          effort,
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
      reason:
        (input.refreshTimedOut ? "The provider refresh timed out. " : "") + describeRefusal(input),
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
    selection:
      best.effort && !best.selection.options?.some((option) => option.id === best.effort?.id)
        ? {
            ...best.selection,
            options: [...(best.selection.options ?? []), { id: best.effort.id, value: "xhigh" }],
          }
        : best.selection,
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
    const requests = input.providers.flatMap((provider) => {
      if (!subscriptionDriver(provider.driver) || !matchesRoutingTarget(provider, input.target))
        return [];
      const scoped = { ...input, now };
      const models = routingModels(scoped, provider);
      const check = (model?: string) =>
        forkRoutingEligibility({
          ...scoped,
          provider,
          ...(model !== undefined && { model }),
        });
      const checks = models.length
        ? models.map(({ slug }) => check(slug))
        : [check(input.target?.model)];
      if (checks.some(({ state }) => state === "available")) return [];
      const refresh = checks.find((result) => result.refresh)?.refresh;
      return refresh ? [{ instanceId: provider.instanceId, refresh }] : [];
    });
    const id = input.target?.providerInstanceId;
    if (id && !input.providers.some((provider) => provider.instanceId === id)) {
      const driver = configuredRoutingDriver(input, id);
      if (
        driver &&
        !accountRestriction(input.settings, input.projectId, id, driver) &&
        (input.target?.driverKind === undefined ||
          forkRoutingDriverKind(input.target.driverKind) === forkRoutingDriverKind(driver))
      ) {
        requests.push({ instanceId: id, refresh: "provider" });
      }
    }
    if (requests.length === 0) return { providers: input.providers, refreshTimedOut: false };
    const refreshed = yield* Effect.forEach(
      requests,
      ({ instanceId, refresh }) =>
        refresh === "provider"
          ? registry.refreshInstance(instanceId).pipe(Effect.asVoid)
          : registry.refreshUsageLimits(instanceId),
      { concurrency: 3, discard: true },
    ).pipe(Effect.timeoutOption("20 seconds"));
    return { providers: yield* registry.getProviders, refreshTimedOut: Option.isNone(refreshed) };
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
    ...(yield* refreshForkRoutingProviders(registry, input)),
    now: yield* Clock.currentTimeMillis,
  });
});
