import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { CommandId, type EnvironmentId, ProjectId } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { splitOnboardingProjectPath } from "../../onboarding/projectImport.logic";
import { useProject } from "../../state/entities";
import { forkMemory } from "../../state/forkMemory";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

const NEXT_STEPS = [
  msg("Catch me up on this project"),
  msg("Find what to fix next"),
  msg("Plan the next change with me"),
] as const;

/**
 * T3 fork: a new project coordinator's empty thread. One intro and a few next steps, no
 * questions: the main coordinator already asked them. A step sends itself as the first message.
 */
export function ForkProjectIntro({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const project = useProject(scopeProjectRef(environmentId, ProjectId.make(projectId)));
  const openCoordinator = useAtomCommand(forkMemory.openCoordinator, { reportFailure: true });
  const [sending, setSending] = useState(false);
  const name = project ? splitOnboardingProjectPath(project.workspaceRoot).name : null;

  const send = async (text: string) => {
    setSending(true);
    const result = await openCoordinator({
      environmentId,
      input: {
        projectId: ProjectId.make(projectId),
        global: false,
        message: { commandId: CommandId.make(randomUUID()), text },
      },
    });
    if (result._tag !== "Success") setSending(false);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-6 pt-10 pb-6">
        <p className="max-w-[80%] self-start rounded-2xl bg-muted px-3.5 py-2 text-sm text-pretty">
          {name === null
            ? gt(
                "I'm this project's coordinator. Tell me what you want done, and I'll run it in task threads and report back.",
              )
            : gt(
                "I'm the coordinator for {project}. Tell me what you want done, and I'll run it in task threads and report back.",
                { project: name },
              )}
        </p>
        <div className="flex flex-wrap justify-end gap-1.5">
          {NEXT_STEPS.map((step, index) => (
            <Button
              key={step}
              size="sm"
              variant={index === 0 ? "default" : "outline"}
              disabled={sending}
              onClick={() => void send(m(step))}
            >
              {m(step)}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
