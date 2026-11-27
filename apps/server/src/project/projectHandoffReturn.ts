import type { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

export const PROJECT_HANDOFF_NEXT =
  "Reply with the project link and end your turn now. forkT delivers the result or blocker to Main automatically. Do not call t3_thread_wait, check status, or request a separate report.";

// Only the authorized handoff installs this value. A client-chosen message or command ID cannot register a return.
export class ProjectHandoffRegistration extends Context.Reference<
  | {
      readonly commandId: CommandId;
      readonly environmentId: EnvironmentId;
      readonly sourceThreadId: ThreadId;
    }
  | undefined
>("fork/ProjectHandoffRegistration", { defaultValue: () => undefined }) {}
