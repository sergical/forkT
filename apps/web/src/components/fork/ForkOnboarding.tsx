import * as Sentry from "@sentry/react";
import { CommandId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useProjectScans } from "../../onboarding/useProjectScans";
import type { WelcomeImportSelection } from "../../onboarding/welcomeState";
import { forkSentryEnabled } from "../../observability/forkSentry";
import { forkMemory } from "../../state/forkMemory";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useProjectImport, useWelcomeAgents } from "../onboarding/WelcomePage";
import { Button } from "../ui/button";

/**
 * T3 fork: the main coordinator introduces itself in its own thread. Scripted, so it runs before
 * any agent is set up and costs nothing; every answer changes a real setting. The first real
 * message, picked here or typed in the composer, ends it.
 */

type ProjectCandidate = ReturnType<typeof useProjectImport>["recent"][number];

type Line =
  | { readonly kind: "coordinator" | "you" | "memo"; readonly text: string }
  | { readonly kind: "projects"; readonly candidates: ReadonlyArray<ProjectCandidate> }
  | { readonly kind: "example"; readonly project: string };

interface Choice {
  readonly label: string;
  readonly primary?: boolean;
  readonly value: string;
}

const HANDS_ON_MEMORY_ID = "hands-on";
const SKIP: Choice = { label: "Skip, let me work", value: "skip" };
const HANDS_ON: ReadonlyArray<Choice & { readonly memory: string }> = [
  {
    label: "Ask before big calls",
    value: "big-calls",
    primary: true,
    memory: "Ask before any big or hard-to-undo decision; decide small ones and report them.",
  },
  {
    label: "Only the important ones",
    value: "important",
    memory: "Decide most things alone; ask only about decisions that change scope or cost.",
  },
  {
    label: "Run with it, I'll check in",
    value: "hands-off",
    memory: "Work hands-off: decide in my place, record why, and report the results.",
  },
];

const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, reducedMotion() ? 0 : ms));

const traceAnswer = (beat: string, choice: string) => {
  if (!forkSentryEnabled) return;
  Sentry.startSpan(
    { name: `fork.onboarding.${beat}`, op: "ui.action", attributes: { choice } },
    () => {},
  );
};

export function ForkOnboarding({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  /** The coordinator's thread, when it exists: the model pick applies to it too. */
  readonly threadId?: ThreadId;
}) {
  const navigate = useNavigate();
  const [lines, setLines] = useState<ReadonlyArray<Line & { readonly id: number }>>([]);
  const [typing, setTyping] = useState(false);
  const [choices, setChoices] = useState<ReadonlyArray<Choice> | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const answer = useRef<((value: string) => void) | null>(null);

  const agents = useWelcomeAgents(environmentId);
  const scans = useProjectScans([environmentId]);
  const [importSelection, setImportSelection] = useState<WelcomeImportSelection | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const holdPage = useRef(false);
  const imported = useRef<{ readonly threads: number } | null>(null);
  const projectImport = useProjectImport({
    scans,
    importSelection,
    onImportSelectionChange: setImportSelection,
    isImporting,
    setIsImporting,
    holdPageRef: holdPage,
    onDone: async (_project, _warning, threads = 0) => {
      imported.current = { threads };
      // Returning true keeps the import busy for a page that navigates away; this one stays.
      setIsImporting(false);
      return true;
    },
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const setThreadModel = useOrchestrationCommand(threadEnvironment.setModelSelection, {
    label: "change model",
  });
  const saveMemory = useAtomCommand(forkMemory.save, { reportFailure: true });
  const openCoordinator = useAtomCommand(forkMemory.openCoordinator, { reportFailure: true });

  // The script reads these as they arrive; they change while it waits.
  const readImported = () => imported.current;
  const handsOn = useEnvironmentQuery(
    forkMemory.get({ environmentId, input: { projectId: null, id: HANDS_ON_MEMORY_ID } }),
  );
  const read = useEffectEvent(() => ({
    agents,
    projectImport,
    scans,
    picked,
    isImporting,
    handsOn,
  }));
  const run = useEffectEvent((isLive: () => boolean) => {
    const add = (line: Line) => {
      if (isLive()) setLines((current) => [...current, { ...line, id: current.length }]);
    };
    const say = async (...texts: ReadonlyArray<string>) => {
      for (const text of texts) {
        if (!isLive()) return;
        setTyping(true);
        await pause(Math.min(1_000, 300 + text.length * 10));
        setTyping(false);
        add({ kind: "coordinator", text });
        await pause(180);
      }
    };
    const ask = (options: ReadonlyArray<Choice>) =>
      new Promise<string>((resolve) => {
        answer.current = (value) => {
          answer.current = null;
          setChoices(null);
          const label = options.find((option) => option.value === value)?.label ?? value;
          add({ kind: "you", text: label });
          resolve(value);
        };
        if (isLive()) setChoices(options);
      });
    const waitFor = async (ready: () => boolean, ms: number) => {
      for (let waited = 0; waited < ms && !ready(); waited += 200) await pause(200);
    };

    let exampleProject: string | undefined;
    const script = async () => {
      await say(
        "Hey, I'm your coordinator 👋",
        "This is the one chat you keep. Tell me what you want, and I'll get it done in the right project.",
        "Give me a second, I'm looking at what's on this machine.",
      );
      await waitFor(() => !read().agents.checking, 8_000);

      const found = read().agents.found;
      if (found.length === 0) {
        await say("I don't see a coding agent set up yet. I need one to do any work.");
        const choice = await ask([{ label: "Set one up", value: "setup", primary: true }, SKIP]);
        traceAnswer("agents", choice);
        if (choice === "setup") void navigate({ to: "/welcome" });
        return;
      }
      const names = found.map((provider) => provider.displayName ?? provider.driver);
      await say(`You're signed in to ${names.join(" and ")}. Nice.`, "Who should I think with?");
      const models = found
        .flatMap((provider) =>
          provider.models.slice(0, 1).map((model) => ({
            label: model.name,
            value: `${provider.instanceId}/${model.slug}`,
            selection: { instanceId: provider.instanceId, model: model.slug },
          })),
        )
        .slice(0, 3);
      const model = await ask([
        ...models.map((option, index) => ({ ...option, primary: index === 0 })),
        SKIP,
      ]);
      traceAnswer("model", model === "skip" ? "skip" : "picked");
      const selection = models.find((option) => option.value === model)?.selection;
      if (selection === undefined) return finish();
      const savedDefault = await updateSettings({
        environmentId,
        input: { patch: { defaultModelSelection: selection } },
      });
      const switched =
        threadId === undefined
          ? savedDefault
          : await setThreadModel({ environmentId, input: { threadId, modelSelection: selection } });
      await say(
        savedDefault._tag === "Success" && switched._tag === "Success"
          ? "Done. That's the default for new work too. Switch any time below."
          : "That didn't save. You can pick a model below or in Settings.",
      );

      await waitFor(() => read().scans.every((scan) => scan.data !== null), 10_000);
      const candidates = read().projectImport.recent.slice(0, 6);
      if (candidates.length > 0) {
        setPicked(new Set(candidates.map((candidate) => candidate.key)));
        await say("You've been busy. I found these in your agent history:");
        add({ kind: "projects", candidates });
        await say("Each one gets its own coordinator, and its old threads come along.");
        const bring = await ask([
          { label: "Bring them in", value: "import", primary: true },
          { label: "Not now", value: "later" },
          SKIP,
        ]);
        traceAnswer("projects", bring);
        if (bring === "skip") return finish();
        if (bring === "import") {
          const chosen = candidates.filter((candidate) => read().picked?.has(candidate.key));
          exampleProject = chosen[0]?.title;
          imported.current = null;
          await read().projectImport.runImport(chosen);
          // Setup finishes after the import returns; a stopped import never reports back.
          await waitFor(() => imported.current !== null || !read().isImporting, 15_000);
          const result = readImported();
          await say(
            result === null
              ? "That didn't go through. You can add them any time from Add project."
              : `Done. ${chosen.length} ${chosen.length === 1 ? "project" : "projects"}, ${result.threads} ${result.threads === 1 ? "thread" : "threads"}. I'm not starting cold.`,
          );
        }
      } else {
        await say("No past work to bring in. Tell me a folder any time and I'll add it.");
      }

      await say("How hands-on do you want to be?");
      const style = await ask([...HANDS_ON, SKIP]);
      traceAnswer("hands_on", style);
      const choice = HANDS_ON.find((option) => option.value === style);
      if (choice === undefined) return finish();
      // Onboarding reruns while this thread is empty, so the preference may already exist.
      await waitFor(() => !read().handsOn.isPending, 5_000);
      const saved = await saveMemory({
        environmentId,
        input: {
          projectId: null,
          id: HANDS_ON_MEMORY_ID,
          commandId: CommandId.make(randomUUID()),
          expectedRevision: read().handsOn.data?.revision ?? 0,
          kind: "preference",
          title: "How hands-on to be",
          body: choice.memory,
          reason: "Chosen during setup.",
          sources: [],
        },
      });
      await say("Got it.");
      add({
        kind: "memo",
        text:
          saved._tag === "Success"
            ? `Remembered: ${choice.label.toLowerCase()}`
            : "Couldn't save that. You can add it on the memory page.",
      });
      await say("That's memory: you say it once. You can read and edit everything I keep.");

      const project = exampleProject ?? "your project";
      await say("One more thing, then we work. Here's what a normal ask looks like:");
      add({ kind: "example", project });
      await pause(1_600);
      await say("You see the ask and the result. Everything in between is one click away.");
      return finish();
    };

    const finish = async () => {
      await say("So, what's first? Pick one or type below.");
      const first = await ask([
        { label: "Catch me up on my projects", value: "Catch me up on my projects." },
        { label: "Plan the next change with me", value: "Plan the next change with me." },
      ]);
      traceAnswer("first_task", "starter");
      await openCoordinator({
        environmentId,
        input: { global: true, message: { commandId: CommandId.make(randomUUID()), text: first } },
      });
    };

    void script();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the scripted conversation once per mount and stops it on unmount
  useEffect(() => {
    let live = true;
    run(() => live);
    return () => {
      live = false;
      answer.current = null;
    };
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
      <div
        role="log"
        aria-label="Coordinator introduction"
        className="mx-auto flex w-full max-w-2xl flex-col gap-1.5 px-6 pt-10 pb-6"
      >
        {lines.map((line) => {
          switch (line.kind) {
            case "coordinator":
              return (
                <p
                  key={line.id}
                  className="max-w-[80%] self-start rounded-2xl bg-muted px-3.5 py-2 text-sm text-pretty"
                >
                  {line.text}
                </p>
              );
            case "you":
              return (
                <p
                  key={line.id}
                  className="my-2 max-w-[80%] self-end rounded-2xl bg-primary px-3.5 py-2 text-sm text-primary-foreground"
                >
                  {line.text}
                </p>
              );
            case "memo":
              return (
                <p
                  key={line.id}
                  className="flex items-center gap-1.5 self-start px-1 text-xs text-muted-foreground"
                >
                  <span className="size-1.5 rounded-sm bg-warning" />
                  {line.text}
                </p>
              );
            case "projects":
              return (
                <ul
                  key={line.id}
                  className="w-full max-w-md self-start overflow-hidden rounded-xl border"
                >
                  {line.candidates.map((candidate) => (
                    <li key={candidate.key} className="border-b last:border-b-0">
                      <label className="flex items-center gap-2.5 px-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          checked={picked?.has(candidate.key) ?? false}
                          disabled={choices === null || isImporting}
                          onChange={(event) => {
                            const next = new Set(picked);
                            if (event.target.checked) next.add(candidate.key);
                            else next.delete(candidate.key);
                            setPicked(next);
                          }}
                        />
                        <span className="truncate">{candidate.title}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                          {candidate.threadCount}{" "}
                          {candidate.threadCount === 1 ? "thread" : "threads"}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              );
            case "example":
              return (
                <div
                  key={line.id}
                  className="my-1 grid gap-0.5 self-start border-l-2 py-1 pl-3 text-sm text-muted-foreground"
                >
                  <span>
                    <b className="font-medium text-foreground">you</b> “the sidebar header is
                    misaligned”
                  </span>
                  <span>
                    → handed to the <b className="font-medium text-foreground">{line.project}</b>{" "}
                    coordinator
                  </span>
                  <span>→ worktree · fix · checks pass</span>
                  <span>
                    ← <b className="font-medium text-foreground">ready for review</b>, 1 file
                    changed
                  </span>
                </div>
              );
          }
        })}
        {typing ? (
          <p
            role="status"
            aria-label="Coordinator is typing"
            className="flex gap-1 self-start rounded-2xl bg-muted px-3.5 py-3"
          >
            <span className="size-1.5 rounded-full bg-muted-foreground/50" />
            <span className="size-1.5 rounded-full bg-muted-foreground/50" />
            <span className="size-1.5 rounded-full bg-muted-foreground/50" />
          </p>
        ) : null}
        {choices ? (
          <div className="mt-2 flex flex-wrap justify-end gap-1.5">
            {choices.map((choice) => (
              <Button
                key={choice.value}
                size="sm"
                variant={
                  choice.primary ? "default" : choice.value === "skip" ? "ghost-muted" : "outline"
                }
                disabled={isImporting}
                onClick={() => answer.current?.(choice.value)}
              >
                {choice.label}
              </Button>
            ))}
          </div>
        ) : null}
        {/* Remounts as the conversation grows, keeping the newest message in view. */}
        <div
          key={`${lines.length}:${typing}:${choices !== null}`}
          ref={(node) => {
            node?.scrollIntoView({ block: "end", behavior: reducedMotion() ? "auto" : "smooth" });
          }}
        />
      </div>
    </div>
  );
}
