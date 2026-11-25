import {
  ForkDream,
  ForkDreamInput,
  ForkCoordinator,
  ForkCoordinatorOpenInput,
  ForkMemory,
  ForkMemoryForgetInput,
  ForkMemoryKey,
  ForkMemorySaveInput,
  ForkMemorySearchInput,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as ForkDreamService from "../../../project/ForkDreamService.ts";
import * as ForkCoordinatorService from "../../../project/ForkCoordinatorService.ts";
import * as ForkMemoryService from "../../../project/ForkMemoryService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

import { ProjectDeliverableHandoff } from "../../handoffProjectDeliverable.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ForkMemoryService.ForkMemoryService,
  ],
};

const Search = Tool.make("t3_memory_search", {
  ...shared,
  description:
    "Find saved preferences, decisions and lessons. projectId:null searches personal memory; a project ID searches only that project. Empty query lists recent entries. Results are an index; read relevant entries for evidence. Current code and user instructions take precedence.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...ForkMemorySearchInput.fields,
  }),
  success: Schema.Array(
    Schema.Struct({
      ...ForkMemoryKey.fields,
      kind: ForkMemory.fields.kind,
      title: ForkMemory.fields.title,
      revision: ForkMemory.fields.revision,
      updatedAt: ForkMemory.fields.updatedAt,
    }),
  ),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const Read = Tool.make("t3_memory_read", {
  ...shared,
  description:
    "Read a saved memory and its retained source excerpts. history:true also returns prior revisions.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...ForkMemoryKey.fields,
    history: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    memory: Schema.NullOr(ForkMemory),
    history: Schema.Array(ForkMemory),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const Save = Tool.make("t3_memory_save", {
  ...shared,
  description:
    "Save a durable, source-backed lesson or explicit user decision. Read before editing; expectedRevision:0 creates. Cite completed message IDs, not invented evidence. Use a stable id; never reuse a forgotten id. Reuse commandId only for an identical retry. A conflict requires rereading and reconciling. Keep project facts in their project; personal memory is for general preferences. Needs full-access/default mode.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...ForkMemorySaveInput.fields,
    sources: ForkMemorySaveInput.fields.sources.check(Schema.isMinLength(1)),
  }),
  success: ForkMemory,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

const Forget = Tool.make("t3_memory_forget", {
  ...shared,
  description:
    "Forget a memory only when the user requests it. Removes its content, source copies and revision history; prevents retries restoring this id. Read first for expectedRevision. Needs full-access/default mode.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...ForkMemoryForgetInput.fields,
  }),
  success: Schema.Struct({ forgotten: Schema.Boolean }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

const Coordinator = Tool.make("t3_coordinator_open", {
  ...shared,
  description:
    "Open a persistent T3 fork coordinator. global:false selects the project's coordinator; global:true selects this environment's main coordinator. Reuses its conversation, or creates an idle one. From main, pass global:false and handoff to queue a known-project deliverable with its source and get an openable receipt in one call. Needs full-access/default mode.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...ForkCoordinatorOpenInput.fields,
    handoff: Schema.optional(ProjectDeliverableHandoff),
  }),
  success: Schema.Struct({
    ...ForkCoordinator.fields,
    link: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
  dependencies: [...shared.dependencies, ForkCoordinatorService.ForkCoordinatorService],
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const Dream = Tool.make("t3_dream_start", {
  ...shared,
  description:
    "Only when the user requests a Dream review: snapshot recent completed project work, including workers, and launch a bounded review in a separate plan-mode thread. Produces proposals, without saving memory or editing code. An active or unchanged review is reused. Reuse commandId after a lost reply. Follow and cancel through normal thread tools. Needs full-access/default mode.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...ForkDreamInput.fields,
  }),
  success: ForkDream,
  dependencies: [...shared.dependencies, ForkDreamService.ForkDreamService],
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const MemoryToolkit = Toolkit.make(Search, Read, Save, Forget, Coordinator, Dream);
