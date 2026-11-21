import { createFileRoute } from "@tanstack/react-router";
import { ForkPage } from "../components/fork/ForkPage";

export const Route = createFileRoute("/_chat/fork")({ component: ForkPage });
