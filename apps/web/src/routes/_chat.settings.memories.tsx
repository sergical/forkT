import { createFileRoute } from "@tanstack/react-router";
import { ForkPage } from "../components/fork/ForkPage";
import { validateMemoriesSearch } from "../components/fork/memories.logic";

export const Route = createFileRoute("/_chat/settings/memories")({
  validateSearch: validateMemoriesSearch,
  component: ForkPage,
});
