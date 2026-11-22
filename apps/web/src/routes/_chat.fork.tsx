import { createFileRoute, redirect } from "@tanstack/react-router";
import { validateMemoriesSearch } from "../components/fork/memories.logic";

export const Route = createFileRoute("/_chat/fork")({
  validateSearch: validateMemoriesSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/memories", search, replace: true });
  },
});
