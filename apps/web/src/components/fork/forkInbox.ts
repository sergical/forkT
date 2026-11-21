import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

export function pendingForkThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
) {
  return threads.flatMap((thread) => {
    if (thread.environmentId !== environmentId) return [];
    if (projectId !== null && thread.projectId !== projectId) return [];
    const reason = thread.hasPendingApprovals
      ? "Approval needed"
      : thread.hasActionableProposedPlan
        ? "Plan ready"
        : thread.hasPendingUserInput || thread.pendingSubagentRequest != null
          ? "Question waiting"
          : null;
    return reason === null ? [] : [{ thread, reason }];
  });
}
