import { useAtomValue } from "@effect/atom-react";
import { CommandId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Link, useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { forkMemory } from "../../state/forkMemory";
import { useAtomCommand } from "../../state/use-atom-command";
import { ForkDecisionInbox } from "../fork/ForkDecisionInbox";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { ForkCoordinatorAccounts } from "./ForkCoordinatorAccounts";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

export function ForkThreadTools() {
  const gt = useGT();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects().filter((project) => project.archivedAt == null);
  const [scopeKey, setScopeKey] = useState("");
  const environments = [...new Set(projects.map((project) => project.environmentId))];
  const scopes = [
    ...projects.map((project) => ({
      key: `${project.environmentId}/${project.id}`,
      environmentId: project.environmentId,
      projectId: project.id,
      title: project.title,
    })),
    ...environments.map((environmentId) => ({
      key: `${environmentId}/all`,
      environmentId,
      projectId: null,
      title: gt("All projects"),
    })),
  ];
  const selected = scopes.find((scope) => scope.key === scopeKey) ?? scopes[0];
  if (!selected)
    return (
      <>
        {primaryEnvironmentId ? (
          <ForkCoordinatorAccounts environmentId={primaryEnvironmentId} />
        ) : null}
        <p className="text-sm text-muted-foreground">
          <T>Add a project to use coordinators and Dream.</T>
        </p>
      </>
    );
  return (
    <div className="space-y-6">
      <ForkCoordinatorAccounts
        key={selected.environmentId}
        environmentId={selected.environmentId}
      />
      <div className="max-w-sm">
        <label className="mb-2 block text-sm font-medium" htmlFor="fork-project">
          <T>Project</T>
        </label>
        <Select
          value={selected.key}
          onValueChange={(value) => {
            if (value) setScopeKey(value);
          }}
        >
          <SelectTrigger id="fork-project">
            <SelectValue>{selected.title}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {scopes.map((scope) => (
              <SelectItem key={scope.key} value={scope.key}>
                {scope.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {selected.projectId ? (
        <CoordinatorControls
          key={`coordinator:${selected.key}`}
          environmentId={selected.environmentId}
          projectId={selected.projectId}
        />
      ) : null}
      <section className="space-y-3" aria-label={gt("Inbox")}>
        <h2 className="text-lg font-medium">
          <T>Inbox</T>
        </h2>
        {selected.projectId === null && selected.environmentId === primaryEnvironmentId ? (
          <Link to="/inbox" className="text-sm underline">
            {gt("Inbox")}
          </Link>
        ) : (
          <ForkDecisionInbox
            environmentId={selected.environmentId}
            projectId={selected.projectId}
          />
        )}
      </section>
    </div>
  );
}

function CoordinatorControls({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const gt = useGT();
  const dream = useAtomCommand(forkMemory.startDream, { label: "start Dream review" });
  const canDream = useAtomValue(forkMemory.startDream.permissionAtom(environmentId));
  const open = useAtomCommand(forkMemory.openCoordinator, { label: "open coordinator" });
  const allowed = useAtomValue(forkMemory.openCoordinator.permissionAtom(environmentId));
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enter = async (global: boolean) => {
    if (busy || !allowed) return;
    setBusy(true);
    setError(null);
    const result = await open({
      environmentId,
      input: global ? { global } : { projectId, global },
    });
    setBusy(false);
    if (result._tag === "Success")
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: result.value.threadId },
      });
    else setError(String(squashAtomCommandFailure(result)));
  };
  const startDream = async () => {
    if (busy || !canDream) return;
    setBusy(true);
    setError(null);
    const result = await dream({
      environmentId,
      input: { projectId, commandId: CommandId.make(randomUUID()) },
    });
    setBusy(false);
    if (result._tag === "Success")
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: result.value.threadId },
      });
    else setError(String(squashAtomCommandFailure(result)));
  };
  return (
    <section className="space-y-3 rounded-xl border p-5" aria-label={gt("Coordinators")}>
      <div className="flex flex-wrap gap-3">
        <Button disabled={!allowed || busy} onClick={() => void enter(false)}>
          <T>Open project coordinator</T>
        </Button>
        <Button variant="outline" disabled={!allowed || busy} onClick={() => void enter(true)}>
          <T>Open main coordinator</T>
        </Button>
        <Button variant="outline" disabled={busy || !canDream} onClick={() => void startDream()}>
          <T>Dream about this project</T>
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
