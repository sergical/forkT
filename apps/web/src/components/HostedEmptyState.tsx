import { Link } from "@tanstack/react-router";
import { T } from "gt-react";
import type { ReactNode } from "react";

import { APP_DISPLAY_NAME } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { isElectron } from "../env";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { FORK_REPOSITORY_URL } from "~/branding.logic";
import { CommandBlock } from "./CommandBlock";
import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

/** Home screen for the hosted app before any computer is added. */
export function HostedEmptyState() {
  const cloudEnabled = hasCloudPublicConfig();
  const localEnvironmentOff = isLocalEnvironmentDisabled();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>
              {localEnvironmentOff ? <T>This computer is off</T> : <T>No computer connected</T>}
            </EmptyTitle>
            <EmptyDescription>
              {localEnvironmentOff ? (
                <T>Turn it back on, or connect a different computer.</T>
              ) : cloudEnabled ? (
                <T>Your agents run on your computer.</T>
              ) : (
                <T>Your agents run on your computer. Start forkT there first.</T>
              )}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            {localEnvironmentOff ? (
              <Button render={<Link to="/settings/connections" />} size="sm">
                <T>Open Environments</T>
              </Button>
            ) : (
              <ol className="w-full space-y-4 text-left">
                <PairingSteps />
              </ol>
            )}
          </EmptyContent>
        </Empty>
      </div>
    </SidebarInset>
  );
}

function PairingSteps() {
  return (
    <>
      <SetupStep number={1}>
        <RunOnComputer command="t3 pair" />
      </SetupStep>
      <SetupStep number={2}>
        <Button render={<Link to="/settings/connections" />} size="sm">
          <T>Add pairing link</T>
        </Button>
      </SetupStep>
    </>
  );
}

function SetupStep({
  number,
  children,
}: {
  readonly number: number;
  readonly children: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="w-2 shrink-0 pt-1 text-muted-foreground">{number}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function RunOnComputer({ command }: { readonly command: string }) {
  return (
    <>
      <p>
        <T>Run on your computer:</T>
      </p>
      <CommandBlock command={command} />
      <a
        className="mt-2 inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        href={FORK_REPOSITORY_URL}
        target="_blank"
        rel="noreferrer noopener"
      >
        <T>About forkT on GitHub</T>
      </a>
    </>
  );
}
