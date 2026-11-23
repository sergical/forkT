import {
  AuthOrchestrationOperateScope,
  type OrchestrationV2PlanArtifact,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionSelected,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  derivePendingThreadRequests,
  fullAccessOverrideExplanation,
  seedUserInputDraftAnswers,
  type ThreadPendingApproval,
  type ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { newMessageId } from "~/lib/utils";
import { Link } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";
import { T, useGT, useMessages, Var } from "gt-react";
import { useRef, useState, type ReactNode } from "react";
import { useProjects, useQuietThreadProjection, useQuietThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { ComposerPendingApprovalActions } from "../chat/ComposerPendingApprovalActions";
import { ProposedPlanCard } from "../chat/ProposedPlanCard";
import { PLAN_IMPLEMENTATION_PROMPT_PREFIX } from "../../proposedPlan";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";

function useInboxThreads(environmentId: EnvironmentId, projectId: ProjectId | null) {
  return useQuietThreadShells().filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.archivedAt == null &&
      thread.deletedAt == null &&
      (projectId === null || projectId === thread.projectId) &&
      (thread.hasPendingApprovals ||
        thread.hasPendingUserInput ||
        thread.hasActionableProposedPlan),
  );
}

export function ForkInboxButton({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const pending = useInboxThreads(environmentId, null).length > 0;
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={pending ? gt("Inbox, decisions pending") : gt("Inbox")}
          />
        }
      >
        <InboxIcon className="size-4" />
        <T>Inbox</T>
        {pending && <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            <T>Inbox</T>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <ForkDecisionInbox
            environmentId={environmentId}
            projectId={null}
            onOpenOrigin={() => setOpen(false)}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function ForkDecisionInbox({
  environmentId,
  projectId,
  onOpenOrigin,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  onOpenOrigin?: (() => void) | undefined;
}) {
  const projects = useProjects();
  const [recorded, setRecorded] = useState<{ message: string } | null>(null);
  const candidates = useInboxThreads(environmentId, projectId);
  return (
    <div className="divide-y">
      {recorded && (
        <p className="pb-2 text-sm" role="status">
          {recorded.message}
        </p>
      )}
      {candidates.length === 0 && (
        <p className="text-sm text-muted-foreground">
          <T>No decisions need your attention.</T>
        </p>
      )}
      {candidates.map((thread) => (
        <InboxThread
          key={thread.id}
          thread={thread}
          onRecorded={(message) => setRecorded({ message })}
          onOpenOrigin={onOpenOrigin}
          projectName={
            projects.find(
              (project) =>
                project.id === thread.projectId && project.environmentId === environmentId,
            )?.title
          }
        />
      ))}
    </div>
  );
}

function InboxThread({
  thread,
  projectName,
  onOpenOrigin,
  onRecorded,
}: {
  thread: EnvironmentThreadShell;
  projectName: string | undefined;
  onRecorded: (message: string) => void;
  onOpenOrigin: (() => void) | undefined;
}) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const projection = useQuietThreadProjection(threadRef)?.projection;
  if (projection === undefined) {
    return (
      <p className="py-3 text-sm text-muted-foreground" role="status">
        <T>
          Loading request from <Var>{thread.title}</Var>…
        </T>
      </p>
    );
  }
  const { approvals, userInputs } = derivePendingThreadRequests(projection);
  const origin = (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(threadRef)}
      onClick={onOpenOrigin}
      className="text-xs text-muted-foreground hover:underline"
    >
      {projectName && projectName !== thread.title
        ? `${projectName} · ${thread.title}`
        : thread.title}
    </Link>
  );
  return (
    <div className="divide-y">
      {thread.source.pendingRuntimeRequest?.userOnly && (
        <section className="space-y-2 py-3">
          {origin}
          <p className="text-sm">
            <T>Open the thread to respond to this request.</T>
          </p>
        </section>
      )}
      {approvals.map((approval) => (
        <InboxApproval
          key={approval.requestId}
          origin={origin}
          threadRef={threadRef}
          approval={approval}
          onRecorded={onRecorded}
        />
      ))}
      {userInputs.map((prompt) => (
        <InboxQuestion
          key={prompt.requestId}
          origin={origin}
          threadRef={threadRef}
          prompt={prompt}
          onRecorded={onRecorded}
        />
      ))}
      {projection.plans.map((plan) =>
        plan.kind === "proposed_plan" && plan.status === "active" ? (
          <InboxPlan
            key={plan.id}
            plan={plan}
            onRecorded={onRecorded}
            markdown={
              projection.turnItems.flatMap((item) =>
                item.type === "proposed_plan" && item.planId === plan.id ? [item.markdown] : [],
              )[0] ?? plan.markdown
            }
            thread={thread}
            threadRef={threadRef}
            origin={origin}
          />
        ) : null,
      )}
    </div>
  );
}

function InboxPlan({
  plan,
  markdown,
  thread,
  threadRef,
  origin,
  onRecorded,
}: {
  plan: Extract<OrchestrationV2PlanArtifact, { kind: "proposed_plan" }>;
  markdown: string;
  thread: EnvironmentThreadShell;
  threadRef: ScopedThreadRef;
  origin: ReactNode;
  onRecorded: (message: string) => void;
}) {
  const canRespond = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const inFlight = useRef(false);
  const [sending, setSending] = useState(false);
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [changes, setChanges] = useState("");
  const [error, setError] = useState<string | null>(null);
  const gt = useGT();
  const messages = useMessages();

  async function respond(implement: boolean) {
    if (!canRespond || inFlight.current || (!implement && changes.trim() === "")) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    try {
      const result = await startTurn({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: implement ? PLAN_IMPLEMENTATION_PROMPT_PREFIX + markdown : changes.trim(),
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          interactionMode: implement ? "default" : "plan",
          runtimeMode: thread.runtimeMode,
          sourceProposedPlan: { threadId: threadRef.threadId, planId: plan.id },
        },
      });
      if (result._tag === "Success") {
        onRecorded(gt("Plan response recorded"));
      } else if (!isAtomCommandInterrupted(result)) {
        setError(
          thrownErrorMessage(squashAtomCommandFailure(result), messages) ??
            gt("Failed to submit plan response."),
        );
      }
    } catch (cause) {
      setError(thrownErrorMessage(cause, messages) ?? gt("Failed to submit plan response."));
    }
    inFlight.current = false;
    setSending(false);
  }

  return (
    <section className="space-y-2 py-3">
      {origin}
      <ProposedPlanCard
        planMarkdown={markdown}
        environmentId={threadRef.environmentId}
        threadRef={threadRef}
        cwd={undefined}
        workspaceRoot={undefined}
      />
      {requestingChanges && (
        <Textarea
          aria-label={gt("Plan changes")}
          value={changes}
          onChange={(event) => setChanges(event.target.value)}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!canRespond || sending} onClick={() => void respond(true)}>
          <T>Implement plan</T>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canRespond || sending || (requestingChanges && changes.trim() === "")}
          onClick={() => (requestingChanges ? void respond(false) : setRequestingChanges(true))}
        >
          {requestingChanges ? gt("Send changes") : gt("Request changes")}
        </Button>
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function InboxApproval({
  threadRef,
  approval,
  origin,
  onRecorded,
}: {
  threadRef: ScopedThreadRef;
  approval: ThreadPendingApproval;
  origin: ReactNode;
  onRecorded: (message: string) => void;
}) {
  const canRespond = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const answer = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const live = approval.responseCapability === "live";
  const inFlight = useRef(false);
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const m = useMessages();
  const gt = useGT();
  return (
    <section className="space-y-2 py-3">
      {origin}
      <p className="text-sm font-medium">
        <T>Approval needed</T>
      </p>
      {approval.detail && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
          {approval.detail}
        </pre>
      )}
      {approval.appName && <p className="text-xs text-muted-foreground">{approval.appName}</p>}
      {approval.reason && <p className="text-xs text-muted-foreground">{approval.reason}</p>}
      {approval.fullAccessOverride && (
        <p className="text-xs text-muted-foreground">
          {fullAccessOverrideExplanation(approval.fullAccessOverride, m)}
        </p>
      )}
      {!live && (
        <p className="text-xs text-muted-foreground">
          <T>This request can no longer be answered here.</T>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <ComposerPendingApprovalActions
          presentation="inline"
          requestId={approval.requestId}
          isResponding={responding}
          canRespond={live}
          disabled={!canRespond}
          options={approval.options}
          onRespondToApproval={async (requestId, decision) => {
            if (!canRespond || !live || inFlight.current) return;
            inFlight.current = true;
            setResponding(true);
            setError(null);
            try {
              const result = await answer({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, requestId, decision },
              });
              if (result._tag === "Success") {
                onRecorded(gt("Decision recorded"));
              } else if (!isAtomCommandInterrupted(result)) {
                setError(
                  thrownErrorMessage(squashAtomCommandFailure(result), m) ??
                    gt("Failed to submit approval decision."),
                );
              }
            } catch (cause) {
              setError(thrownErrorMessage(cause, m) ?? gt("Failed to submit approval decision."));
            }
            inFlight.current = false;
            setResponding(false);
          }}
        />
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function InboxQuestion({
  threadRef,
  prompt,
  origin,
  onRecorded,
}: {
  threadRef: ScopedThreadRef;
  prompt: ThreadPendingUserInput;
  origin: ReactNode;
  onRecorded: (message: string) => void;
}) {
  const canRespond = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const reply = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>(() =>
    seedUserInputDraftAnswers(prompt.questions, {}),
  );
  const inFlight = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gt = useGT();
  const m = useMessages();
  const answers = buildPendingUserInputAnswers(prompt.questions, drafts);
  const live = prompt.responseCapability !== "not_resumable";
  return (
    <form
      className="space-y-3 py-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!canRespond || !live || answers === null || inFlight.current) return;
        inFlight.current = true;
        setSending(true);
        setError(null);
        try {
          const result = await reply({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, requestId: prompt.requestId, answers },
          });
          if (result._tag === "Success") {
            onRecorded(gt("Answer recorded"));
          } else if (!isAtomCommandInterrupted(result)) {
            setError(
              thrownErrorMessage(squashAtomCommandFailure(result), m) ??
                gt("Failed to submit user input."),
            );
          }
        } catch (cause) {
          setError(thrownErrorMessage(cause, m) ?? gt("Failed to submit user input."));
        }
        inFlight.current = false;
        setSending(false);
      }}
    >
      {origin}
      {prompt.questions.map((question) => {
        const draft = drafts[question.id];
        return (
          <fieldset
            key={question.id}
            disabled={sending || !canRespond || !live}
            className="space-y-2"
          >
            <legend className="whitespace-pre-wrap text-sm font-medium">{question.question}</legend>
            {question.options.map((option) => {
              const value = option.value ?? option.label;
              return (
                <label key={value} className="flex items-start gap-2 text-sm">
                  <input
                    className="mt-1"
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={`${prompt.requestId}-${question.id}`}
                    checked={isPendingUserInputOptionSelected(question, draft, value)}
                    onChange={() =>
                      setDrafts((current) => ({
                        ...current,
                        [question.id]: togglePendingUserInputOptionSelection(
                          question,
                          current[question.id],
                          value,
                        ),
                      }))
                    }
                  />
                  <span>
                    {option.label}
                    {option.description && (
                      <span className="block text-muted-foreground">{option.description}</span>
                    )}
                    {option.preview && (
                      <span className="block whitespace-pre-wrap text-muted-foreground">
                        {option.preview}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
            {question.allowCustomAnswer !== false && (
              <Textarea
                aria-label={question.question}
                placeholder={gt("Type an answer")}
                value={draft?.customAnswer ?? ""}
                onChange={(event) => {
                  const customAnswer = event.target.value;
                  setDrafts((current) => ({ ...current, [question.id]: { customAnswer } }));
                }}
              />
            )}
          </fieldset>
        );
      })}
      {live ? (
        <Button type="submit" size="sm" disabled={!canRespond || sending || answers === null}>
          <T>Send answer</T>
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          <T>This request can no longer be answered here.</T>
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
