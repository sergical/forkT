import { createFileRoute, useLocation } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";

export const Route = createFileRoute("/_chat/usage")({
  component: UsageRoute,
});

function UsageRoute() {
  const showLimits = useLocation({ select: (location) => location.hash === "limits" });
  return <UsagePage key={String(showLimits)} showLimitsInitially={showLimits} />;
}
