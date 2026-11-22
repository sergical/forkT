# T3 fork: pick models by subscription usage left

Research and design only. Nothing here is built. Written 2026-11-21. "Usage low" means *little left*. The user's rule: when the coordinator is Opus 5.5 and little Claude Code usage is left, it hands coordination to Fable 5.2, or to Codex when the work needs no creativity.

## 1. What T3 already knows about usage

Two different "usage" views exist. Only the first one is a meter.

- **Limit bars** (percent of your plan used). One shape for every provider: `id`, `kind` (session / weekly / monthly), `usedPercent` 0–100, `resetsAt`, `windowDurationMins`, optional `modelIds` ([contract](../../packages/contracts/src/providerUsageLimits.ts#L13-L24)). Drawn by [UsageLimits.tsx](../../apps/web/src/components/usage/UsageLimits.tsx).
- **Spend history** on the `/usage` page: tokens and cost counted from local transcripts ([UsageService.ts](../../apps/server/src/usage/UsageService.ts), [UsagePage.tsx](../../apps/web/src/components/usage/UsagePage.tsx)). It cannot say what is left on a plan, so routing must not use it.

| | Claude | Codex |
| --- | --- | --- |
| Source | Claude SDK `get_usage` request, with its own deadline ([ClaudeProvider.ts:540-553](../../apps/server/src/provider/ClaudeProvider.ts#L540-L553)) | `account/rateLimits/read` ([CodexProvider.ts:709-713](../../apps/server/src/provider/CodexProvider.ts#L709-L713)) |
| Windows | `five_hour`, `seven_day`, one weekly window per model-scoped allowance (Fable), monthly spend ([claudeUsageLimits.ts:22-26](../../apps/server/src/provider/claudeUsageLimits.ts#L22-L26), [:187-231](../../apps/server/src/provider/claudeUsageLimits.ts#L187-L231)) | `primary` (5 h) and `secondary` (week) of the main `codex` limit only; per-model limits are dropped, so Sol and Astra share one meter ([codexUsageLimits.ts:59-70](../../apps/server/src/provider/codexUsageLimits.ts#L59-L70)) |
| Pushed during a turn | `rate_limit_event`, session and weekly only ([ClaudeAdapterV2.ts:10832](../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L10832), [claudeUsageLimits.ts:167-185](../../apps/server/src/provider/claudeUsageLimits.ts#L167-L185)) | `account/rateLimits/updated` ([CodexAdapterV2.ts:5043](../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L5043)) |

**Freshness.** A full probe runs every 5 minutes by default ([settings.ts:1104](../../packages/contracts/src/settings.ts#L1104)), but only while something wants provider status ([managedProvider.ts:371-385](../../packages/provider-core/src/server/managedProvider.ts#L371-L385)). So a headless coordinator can see a stale number; `checkedAt` tells it how stale. `providerRegistry.refreshInstance` forces a probe ([OrchestratorMcpService.ts:1650](../../apps/server/src/mcp/OrchestratorMcpService.ts#L1650)).

**Gap.** Agents cannot see any of this: the result of `orchestrator_capabilities` has no usage field ([orchestratorMcp.ts:703-721](../../packages/contracts/src/orchestratorMcp.ts#L703-L721)). Building blocks exist in [usageLimits.ts](../../packages/shared/src/usageLimits.ts): `exhaustedUsageWindow` (:27), `resolveNewThreadModelSelection` (:79, swaps to `fallbackModelSelection` only at 100%), `remainingPercent` (:753), `paceOf` (:782, "ahead / on / under" by ±5 points of time elapsed).

## 2. What the evidence says

**Benchmarks.** Artificial Analysis Intelligence Index v5, all at Max effort. Cost is API price, not subscription burn.

| Model | Index | $/task | Min/task |
| --- | --- | --- | --- |
| [Fable 5.2](https://artificialanalysis.ai/models/claude-fable-5-2) | 65 | 26.54 | 42.0 |
| [Astra 6.2](https://artificialanalysis.ai/models/gpt-6-2-astra) | 62 | 4.00 | 14.0 |
| [Opus 5.5](https://artificialanalysis.ai/models/claude-opus-5-5) | 59 | 10.04 | 25.6 |
| [Sol 6.2](https://artificialanalysis.ai/models/gpt-6-2-sol) | 57 | 1.01 | 9.6 |
| [Sonnet 5.5](https://artificialanalysis.ai/models/claude-sonnet-5-5) | 55 | 10.02 | 32.4 |
| [Terra 6.1](https://artificialanalysis.ai/models/gpt-6-1-terra) | 51 | 0.96 | 15.5 |
| [Haiku 5.5](https://artificialanalysis.ai/models/claude-haiku-5-5) | 36 | 0.41 | 14.8 |

Anthropic: start with Opus 5.5 as "daily driver"; Fable 5.2 can be advisor or orchestrator that delegates to smaller models; on FrontierCode 2.0, Fable at High effort matches Opus at Max for about half the cost ([announcement](https://www.anthropic.com/claude-fable-and-mythos-5-2)). OpenAI: Astra is for "hardest projects", Sol for "everyday work" ([announcement](https://openai.com/index/introducing-gpt-6-2-astra-sol/)).

**Theo (t3.gg).** Warns against fancy model routers, and rarely leaves his default model; he mostly switches to burn tokens from another subscription ([0:20](https://www.youtube.com/watch?v=TWoS5Nmyoc8&t=20), [7:00](https://www.youtube.com/watch?v=TWoS5Nmyoc8&t=420)). Reviews from a *different* model family beat the same family reviewing itself ([6:14](https://www.youtube.com/watch?v=TWoS5Nmyoc8&t=374)). OpenAI models keep reviewing in loops; Opus stops when stuck ([22:34](https://www.youtube.com/watch?v=TWoS5Nmyoc8&t=1354)). On Claude plans, Fable has its own 7-day limit and every 2 points of it also cost 1 point of the weekly limit ([23:23](https://www.youtube.com/watch?v=yh5IAUow4Hc&t=1403)). He is considering Fable as implementer and Astra as playtester, still undecided ([32:23](https://www.youtube.com/watch?v=9KvI-zg4mfo&t=1943)).

**Ben Davis.** Runs Fable as orchestrator, Opus as implementer, Astra 6.2 as reviewer ([17:32](https://www.youtube.com/watch?v=u4IoG2dhNkQ&t=1052)). Astra needs babysitting on vague prompts ([17:13](https://www.youtube.com/watch?v=u4IoG2dhNkQ&t=1033)); his advice is reviewer and "grunt workhorse" ([18:29](https://www.youtube.com/watch?v=u4IoG2dhNkQ&t=1109)). Older (Aug 2026, before 6.2): Fable for vague prompts and clean code, Luna for tightly specified brute-force work ([1:58](https://www.youtube.com/watch?v=PnavRnhuC68&t=118)).

**No public data.** No benchmark or creator test compares planner against implementer for any of these seven models. Sonnet 5.5, Haiku 5.5 and Terra 6.1 get no creator coverage beyond name lists ([Theo 6:40](https://www.youtube.com/watch?v=yh5IAUow4Hc&t=400)); I rank them by Index score and price only. The repo's [model manifest](../../apps/server/src/provider/model-manifest.json) lists no 6.2 slug and no 6.1 Terra (only a legacy 5.6 Terra), so confirm the real slugs with `orchestrator_capabilities` first.

## 3. Decision model

Per provider, take the tightest window that applies to the model (session, weekly, model-scoped weekly). State, using the existing helpers (thresholds are my starting numbers, untested):

- **OUT**: a window is at 100% and not yet reset.
- **TIGHT**: under 20% left, or pace "ahead" with under 50% left.
- **PLENTY**: pace "under", or 70%+ left, or the weekly window resets within 24 h with 10%+ left (use it or lose it).
- **NORMAL**: anything else.

| Task | Needs creativity / vague spec | Concrete spec, no creativity |
| --- | --- | --- |
| Coordinate, plan | Claude PLENTY/NORMAL: Opus 5.5, high. Claude TIGHT: Fable 5.2, high (if Fable's own window has 30%+ left, else Sol 6.2, high). Claude OUT: Sol 6.2, high | Claude PLENTY/NORMAL: Opus 5.5, high. Claude TIGHT or OUT: Sol 6.2, high (Codex not OUT) |
| Implement | Claude: Opus 5.5 high (Fable xhigh only if PLENTY and hard). Claude OUT: Sol 6.2, with exact steps in the brief | Codex first: Sol 6.2, medium. Codex TIGHT/OUT: Sonnet 5.5 medium, or Haiku 5.5 for trivial edits. Terra 6.1 for trivial edits when Codex is NORMAL |
| Review | Other provider than the implementer: Claude impl, then Astra 6.2 high; Codex impl, then Opus 5.5 high. Cap at 3 rounds | Same |
| Research | Opus 5.5 medium (Fable if PLENTY) | Sol 6.2 medium; Haiku 5.5 or Terra 6.1 for lookups |

Rules on top: never default to `max` effort; step effort down one level when the provider is TIGHT. Fable at High matches Opus at Max for about half the cost ([announcement](https://www.anthropic.com/claude-fable-and-mythos-5-2)), which is why it takes over coordination when Claude is TIGHT. It still counts half a point against the weekly limit per point of its own window ([Theo 23:23](https://www.youtube.com/watch?v=yh5IAUow4Hc&t=1403)), so skip it when its own 7-day window has under 30% left. Because the coordinator does not switch its own model mid-thread (decision 2), "hand off coordination" means it delegates the remaining coordination to a new child thread on the chosen model.

## 4. Where it plugs in

1. **Show the data.** Add per-provider `usage` (remaining %, `resetsAt`, `checkedAt`, state) to the `orchestrator_capabilities` result ([contract](../../packages/contracts/src/orchestratorMcp.ts#L703-L721), [tool](../../apps/server/src/mcp/toolkits/orchestrator/tools.ts#L75)).
2. **One rule function** beside the existing helpers in [usageLimits.ts](../../packages/shared/src/usageLimits.ts), shared by server and web.
3. **`delegate_task`.** Today a child inherits the parent's model unless `target.model` is set ([OrchestratorMcpService.ts:1744-1753](../../apps/server/src/mcp/OrchestratorMcpService.ts#L1744-L1753)). The coordinator reads the suggestion and passes an explicit `target`.
4. **Coordinator's own model.** Chosen once at creation: given model, then project default, then previous, then the first provider ([ForkCoordinatorService.ts:88-101](../../apps/server/src/project/ForkCoordinatorService.ts#L88-L101)). A new thread already falls back at 100% via `fallbackModelSelection` ([settings.ts:1443](../../packages/contracts/src/settings.ts#L1443)). Add the rule function there; the coordinator's standing instructions ([forkCoordinatorInstructions.ts](../../apps/server/src/project/forkCoordinatorInstructions.ts)) tell it to follow the suggestion.
5. **Override.** An explicit `target.model`, `providerInstanceId` or `options` always wins ([contract](../../packages/contracts/src/orchestratorMcp.ts#L98-L129)) and so does any model you name in chat. A fork setting `routing: off | advise` keeps today's behavior.

## Decisions (made 2026-11-21)

The user works hands-off and each choice is easy to undo, so these are decided:

1. **Advise, not auto-apply.** The coordinator sees usage and a suggested model, and chooses visibly. Auto-applying inside `delegate_task` is the router Theo warns about, and it hides why a model was chosen.
2. **No model switch mid-thread.** A coordinator's own model is picked only at creation. Mid-thread, it hands work off by delegating instead of switching, which keeps its context intact.
3. **Defaults live in code.** The thresholds and the table above are code defaults, with no settings screen yet.
