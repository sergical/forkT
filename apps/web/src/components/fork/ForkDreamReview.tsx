import { useAtomValue } from "@effect/atom-react";
import {
  dreamDecisions,
  dreamMemoryKinds,
  dreamResultLabel,
  dreamReviewNote,
} from "@t3tools/client-runtime/state/fork-memory";
import type { ForkDreamSuggestion, ScopedThreadRef } from "@t3tools/contracts";
import { Link, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { ArrowUpRightIcon } from "lucide-react";
import { forkMemory } from "../../state/forkMemory";
import { useEnvironmentQuery } from "../../state/query";
import { isThreadRoutePathname } from "../../threadRoutes";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";

declare module "@tanstack/react-router" {
  interface HistoryState {
    dreamReviewOrigin?: string;
  }
}

const linkClass =
  "inline-flex items-center gap-1 pointer-coarse:min-h-11 text-sm font-medium underline decoration-muted-foreground/50 underline-offset-4 hover:text-primary";

export function ForkDreamSourceReturn({
  thread,
  unavailable,
}: {
  thread: ScopedThreadRef;
  unavailable: boolean;
}) {
  const gt = useGT();
  const router = useRouter();
  const fromReview = useLocation({
    select: (location) => location.state.dreamReviewOrigin === thread.threadId,
  });
  return (
    <div className="chat-content-lane flex shrink-0 flex-wrap items-center gap-3 py-2 text-sm">
      <Link
        className={linkClass}
        to="/$environmentId/$threadId"
        params={thread}
        hash="dream-review"
        hashScrollIntoView={false}
        replace
        onClick={(event) => {
          if (
            fromReview &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey &&
            event.button === 0
          ) {
            event.preventDefault();
            router.history.back();
          }
        }}
      >
        {gt("Back to Dream review")}
      </Link>
      {unavailable && (
        <span role="status">
          {gt("The original message is unavailable. The review still has its excerpt.")}
        </span>
      )}
    </div>
  );
}

export function ForkDreamResults({ thread }: { thread: ScopedThreadRef }) {
  const m = useMessages();
  const canRead = useAtomValue(forkMemory.dreamResults.permissionAtom(thread.environmentId));
  const { data } = useEnvironmentQuery(
    canRead
      ? forkMemory.dreamResults.query({
          environmentId: thread.environmentId,
          input: { threadId: thread.threadId },
        })
      : null,
  );
  if (!canRead || !data?.length) return null;
  return (
    <div className="max-h-28 shrink-0 overflow-y-auto border-b border-border/60">
      <div className="chat-content-lane flex flex-col items-start gap-1 py-2">
        {data.map((result) => (
          <Link
            key={result.threadId}
            className={linkClass}
            to="/$environmentId/$threadId"
            params={{ environmentId: thread.environmentId, threadId: result.threadId }}
            hash="dream-review"
            hashScrollIntoView={false}
          >
            {dreamResultLabel(result, m)} <ArrowUpRightIcon aria-hidden className="size-3.5" />
          </Link>
        ))}
      </div>
    </div>
  );
}

export function ForkDreamReview({ thread }: { thread: ScopedThreadRef }) {
  const gt = useGT();
  const m = useMessages();
  const open = useLocation({
    select: (location) =>
      location.hash === "dream-review" && isThreadRoutePathname(location.pathname, thread),
  });
  const navigate = useNavigate();
  const canRead = useAtomValue(forkMemory.dreamReview.permissionAtom(thread.environmentId));
  const query = useEnvironmentQuery(
    canRead
      ? forkMemory.dreamReview.query(
          {
            environmentId: thread.environmentId,
            input: { threadId: thread.threadId },
          },
          open ? "review" : "conversation",
        )
      : null,
  );
  if (!canRead) return null;
  const review = query.data;
  const note = review
    ? dreamReviewNote(review, m)
    : (query.error ??
      (query.isSuccess
        ? gt("Review details are unavailable. See the conversation.")
        : gt("Loading review…")));
  const close = () =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: thread,
      hash: "",
      replace: true,
      resetScroll: false,
    });
  return (
    <>
      <div className="shrink-0 border-b border-border/60">
        <div className="chat-content-lane flex flex-wrap items-center gap-x-3 py-2">
          {(review?.state === "legacy" || review?.state === "incomplete") && (
            <span className="text-sm text-muted-foreground">{note}</span>
          )}
          <Link
            className={linkClass}
            to="/$environmentId/$threadId"
            params={thread}
            replace
            hash="dream-review"
            hashScrollIntoView={false}
          >
            {gt("Open Dream review")} <ArrowUpRightIcon aria-hidden className="size-3.5" />
          </Link>
        </div>
      </div>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{gt("Dream review")}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {note && (
              <p className="text-sm" role="status">
                {note}
              </p>
            )}
            {query.error && (
              <Button variant="outline" onClick={query.refresh}>
                {gt("Retry")}
              </Button>
            )}
            {review?.state === "ready" &&
              review.suggestions.map((suggestion) => (
                <DreamSuggestion
                  key={suggestion.suggestionId}
                  thread={thread}
                  suggestion={suggestion}
                />
              ))}
            <Button variant="link" onClick={close}>
              {gt("View conversation")}
            </Button>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function MemoryWording({
  label,
  wording,
}: {
  label: string;
  wording: ForkDreamSuggestion["proposed"];
}) {
  const m = useMessages();
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs text-muted-foreground">
        {label} · {m(dreamMemoryKinds[wording.kind])}
      </p>
      <p className="whitespace-pre-wrap wrap-anywhere font-medium">{wording.title}</p>
      <p className="whitespace-pre-wrap wrap-anywhere">{wording.body}</p>
    </div>
  );
}

function DreamSuggestion({
  thread,
  suggestion,
}: {
  thread: ScopedThreadRef;
  suggestion: ForkDreamSuggestion;
}) {
  const gt = useGT();
  const m = useMessages();
  const decide = useAtomCommand(forkMemory.decideDream);
  const canDecide = useAtomValue(forkMemory.decideDream.permissionAtom(thread.environmentId));
  const { busy, confirmed, error } = useAtomValue(
    forkMemory.dreamDecisionState(thread, suggestion.suggestionId),
  );
  const status =
    suggestion.status === "saved" || suggestion.status === "kept"
      ? suggestion.status
      : (confirmed ?? suggestion.status);
  const choose = (decision: "save" | "keep") =>
    decide({
      environmentId: thread.environmentId,
      input: { threadId: thread.threadId, suggestionId: suggestion.suggestionId, decision },
    });
  return (
    <section aria-label={suggestion.proposed.title} className="space-y-3 border-b pb-5 text-sm">
      {suggestion.original && (
        <MemoryWording
          label={gt("Original · revision {revision}", { revision: suggestion.expectedRevision })}
          wording={suggestion.original}
        />
      )}
      <MemoryWording
        label={
          suggestion.action === "new"
            ? gt("Proposed new memory")
            : gt("Proposed revision {revision}", { revision: suggestion.expectedRevision + 1 })
        }
        wording={suggestion.proposed}
      />
      <p className="whitespace-pre-wrap wrap-anywhere text-muted-foreground">{suggestion.reason}</p>
      {suggestion.sources.map((source) => (
        <blockquote
          key={source.threadId + "/" + source.messageId}
          className="space-y-1 border-s-2 ps-3"
        >
          <p className="whitespace-pre-wrap wrap-anywhere">{source.text}</p>
          <Link
            className={linkClass}
            to="/$environmentId/$threadId"
            params={{ environmentId: thread.environmentId, threadId: source.threadId }}
            state={{ dreamReviewOrigin: thread.threadId }}
            hash={new URLSearchParams({
              message: source.messageId,
              dream: thread.threadId,
            }).toString()}
            hashScrollIntoView={false}
          >
            {gt("Open source message")} <ArrowUpRightIcon aria-hidden className="size-3.5" />
          </Link>
        </blockquote>
      ))}
      {status !== "pending" && (
        <p role="status" className="font-medium">
          {m(dreamDecisions[status])}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {(status === "pending" || status === "stale") && (
        <div className="flex flex-wrap gap-2">
          {status === "pending" && (
            <Button disabled={!canDecide || busy} onClick={() => void choose("save")}>
              {gt("Save", { $context: "verb, confirm button" })}
            </Button>
          )}
          <Button
            variant="outline"
            disabled={!canDecide || busy}
            onClick={() => void choose("keep")}
          >
            {gt("Keep as is")}
          </Button>
        </div>
      )}
    </section>
  );
}
