import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  dreamDecisions,
  dreamMemoryKinds,
  dreamResultLabel,
  dreamReviewNote,
} from "@t3tools/client-runtime/state/fork-memory";
import type { ForkDreamSuggestion, ScopedThreadRef } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { forkMemory } from "../../state/forkMemory";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { requestThreadMessageJump } from "./threadMessageJump";

export function ForkDreamResults({ thread }: { thread: ScopedThreadRef }) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
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
    <View className="gap-1">
      {data.map((result) => (
        <Button
          key={result.threadId}
          tone="text"
          label={dreamResultLabel(result, m)}
          accessibilityLabel={gt("Open Dream review")}
          accessibilityHint={dreamResultLabel(result, m)}
          onPress={() =>
            navigation.dispatch(
              StackActions.push("Thread", {
                environmentId: thread.environmentId,
                threadId: result.threadId,
              }),
            )
          }
        />
      ))}
    </View>
  );
}

export function ForkDreamReview({ thread }: { thread: ScopedThreadRef }) {
  const gt = useGT();
  const m = useMessages();
  const canRead = useAtomValue(forkMemory.dreamReview.permissionAtom(thread.environmentId));
  const query = useEnvironmentQuery(
    canRead
      ? forkMemory.dreamReview.query({
          environmentId: thread.environmentId,
          input: { threadId: thread.threadId },
        })
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
  return (
    <View className="my-3 gap-3">
      <AppText accessibilityRole="header" className="font-t3-bold text-lg">
        {gt("Dream review")}
      </AppText>
      {note && <AppText>{note}</AppText>}
      {query.error && <Button tone="text" label={gt("Retry")} onPress={query.refresh} />}
      {review?.state === "ready" &&
        review.suggestions.map((suggestion) => (
          <DreamSuggestion key={suggestion.suggestionId} thread={thread} suggestion={suggestion} />
        ))}
    </View>
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
    <View className="gap-1">
      <AppText className="text-xs text-foreground-muted">
        {label} · {m(dreamMemoryKinds[wording.kind])}
      </AppText>
      <AppText selectable className="font-t3-bold">
        {wording.title}
      </AppText>
      <AppText selectable>{wording.body}</AppText>
    </View>
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
  const navigation = useNavigation();
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
    <View className="gap-3 rounded-2xl border border-border bg-card-alt p-4">
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
      <AppText selectable className="text-foreground-muted">
        {suggestion.reason}
      </AppText>
      {suggestion.sources.map((source) => (
        <View
          key={source.threadId + "/" + source.messageId}
          className="border-l-2 border-border pl-3"
        >
          <AppText selectable>{source.text}</AppText>
          <Button
            tone="text"
            label={gt("Open source message")}
            onPress={() => {
              requestThreadMessageJump(
                scopedThreadKey(thread.environmentId, source.threadId),
                source.messageId,
              );
              navigation.dispatch(
                StackActions.push("Thread", {
                  environmentId: thread.environmentId,
                  threadId: source.threadId,
                }),
              );
            }}
          />
        </View>
      ))}
      {status !== "pending" && (
        <AppText accessibilityLiveRegion="polite" className="font-t3-medium">
          {m(dreamDecisions[status])}
        </AppText>
      )}
      {error && <AppText accessibilityRole="alert">{error}</AppText>}
      {(status === "pending" || status === "stale") && (
        <View className="flex-row flex-wrap gap-2">
          {status === "pending" && (
            <Button
              tone="primary"
              label={gt("Save", { $context: "verb, confirm button" })}
              disabled={!canDecide || busy}
              onPress={() => void choose("save")}
            />
          )}
          <Button
            label={gt("Keep as is")}
            disabled={!canDecide || busy}
            onPress={() => void choose("keep")}
          />
        </View>
      )}
    </View>
  );
}
