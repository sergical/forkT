import {
  forkCoordinatorProjectId,
  isForkMainCoordinatorThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import type { ProviderAdapterV2TurnMessage } from "@t3tools/provider-core/server/ProviderAdapter";
import { hashTelemetryId } from "@t3tools/shared/telemetryId";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";

export const privateForkTraces = Effect.serviceOption(ServerConfig).pipe(
  Effect.map((config) => Option.getOrUndefined(config)?.forkSentry?.sampleTraces === true),
);

// Some orchestration ids embed an agent-supplied retry key or a provider's item id.
export function traceThread(thread: OrchestrationV2AppThread) {
  const role = isForkMainCoordinatorThreadId(thread.id)
    ? "main_coordinator"
    : forkCoordinatorProjectId(thread.id) !== null
      ? "project_coordinator"
      : thread.lineage.relationshipToParent === "subagent" || thread.delegatedFrom !== undefined
        ? "delegated_worker"
        : thread.id.startsWith("fork:dream:")
          ? "dream"
          : "ordinary";
  return {
    "fork.thread.role": role,
    "fork.project.ref": hashTelemetryId(thread.projectId),
    "fork.thread.ref": hashTelemetryId(thread.id),
    "fork.thread.root_ref": hashTelemetryId(thread.lineage.rootThreadId),
    ...(thread.lineage.parentThreadId && {
      "fork.thread.parent_ref": hashTelemetryId(thread.lineage.parentThreadId),
    }),
  };
}

export function traceMessage({
  messageId,
  creationSource,
  createdBy,
}: ProviderAdapterV2TurnMessage) {
  return {
    "fork.message.ref": hashTelemetryId(messageId),
    ...(creationSource === "server" &&
      createdBy === "user" &&
      messageId.startsWith("async-answer:") && {
        "fork.decision.ref": hashTelemetryId(messageId.slice("async-answer:".length)),
      }),
  };
}
