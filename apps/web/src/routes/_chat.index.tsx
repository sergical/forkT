import { createFileRoute } from "@tanstack/react-router";
import { ForkHome } from "../components/fork/ForkHome";
import { HostedEmptyState } from "../components/HostedEmptyState";
import { useEnvironments } from "../state/environments";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();
  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }
  return <ForkHome />;
}

export const Route = createFileRoute("/_chat/")({ component: ChatIndexRouteView });
