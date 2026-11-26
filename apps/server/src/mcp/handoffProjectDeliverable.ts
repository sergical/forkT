import {
  CommandId,
  isForkMainCoordinatorThreadId,
  OrchestratorMcpFailure,
  OrchestratorMcpCapabilitiesInput,
  ModelSelection,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ForkCoordinatorService } from "../project/ForkCoordinatorService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";

/** The project and source brief for one deliverable, with a retry key for the current run. */
export const ProjectDeliverableHandoff = Schema.Struct({
  projectId: ProjectId,
  role: OrchestratorMcpCapabilitiesInput.fields.role,
  highJudgment: OrchestratorMcpCapabilitiesInput.fields.highJudgment,
  modelSelection: Schema.optional(ModelSelection),
  source: TrimmedNonEmptyString.check(Schema.isMaxLength(18000)).annotate({
    description:
      "Original request, relevant decisions, and completion criteria for the project coordinator.",
  }),
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
    description: "Stable within this run for this deliverable. Reuse on retry.",
  }),
});

/** Queue a deliverable in its project coordinator and return a receipt for the main coordinator. */
export const handoffProjectDeliverable = Effect.fn("fork.project_handoff")(function* (
  input: typeof ProjectDeliverableHandoff.Type,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "Project handoff");
  if (!isForkMainCoordinatorThreadId(thread.threadId)) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Project handoffs originate in the main coordinator.",
    });
  }
  const { caller } = yield* McpToolAccess.environmentWriteCaller();
  const key = [
    thread.threadId,
    caller?.activeRunId ?? thread.providerSessionId,
    input.projectId,
    input.requestId,
  ]
    .map((part) => `${part.length}:${part}`)
    .join("");
  const origin = McpInvocationContext.threadLinkFor(scope, thread.threadId, "Main coordinator");
  const coordinators = yield* ForkCoordinatorService;
  const destination = yield* coordinators
    .open(
      {
        global: false,
        projectId: input.projectId,
        ...(input.modelSelection && { modelSelection: input.modelSelection }),
        message: {
          commandId: CommandId.make("project-handoff:" + key),
          text: `From ${origin} for this project. Complete and verify the request here. Report the outcome back to the source thread.\n\n${input.source}`,
        },
      },
      {
        senderThreadId: thread.threadId,
        senderRunId: caller?.activeRunId ?? undefined,
        role: input.role,
        highJudgment: input.highJudgment,
      },
    )
    .pipe(
      Effect.mapError(
        (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
      ),
    );
  yield* Effect.annotateCurrentSpan({
    "sentry.op": "fork.project_handoff",
    "t3.handoff.source_thread_id": thread.threadId,
    "t3.handoff.destination_thread_id": destination.threadId,
    "t3.handoff.outcome": "accepted",
    ...(caller?.activeRunId === undefined
      ? {}
      : { "t3.handoff.source_run_id": caller.activeRunId }),
  });
  const link = McpInvocationContext.threadLinkFor(
    scope,
    destination.threadId,
    "Project coordinator",
  );
  return {
    ...destination,
    link,
    message: `Handed off to ${link}. Include this link in your reply.`,
  };
});
