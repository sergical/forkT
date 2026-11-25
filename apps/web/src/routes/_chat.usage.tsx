import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/usage")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: "/settings/usage", hash: location.hash, replace: true });
  },
});
