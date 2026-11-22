import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

/** Counts each in-flight agent run once, including runs paused for input. */
export function countForkUpdateRuns(
  threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "status" | "activityRunStatus">>,
) {
  return threads.filter(
    ({ status, activityRunStatus }) =>
      activityRunStatus != null ||
      status === "preparing" ||
      status === "starting" ||
      status === "running" ||
      status === "waiting",
  ).length;
}
