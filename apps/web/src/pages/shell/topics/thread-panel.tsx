import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, LoginFieldInput, ThreadMessage, TopicSummary } from "@rakazo/contracts";
import {
  activeThreadRuns,
  answerableAskMessageIds,
  chatUserBubbleColors,
  dismissableAskMessageIds,
  isActive,
  isRunWorking,
  liveActivityLine,
  liveMessageComposing,
  newClientId,
  projectMessageReactions,
  separateAskAnswers,
} from "@rakazo/core";
import { Button, cn, SectionHeading, Textarea } from "@rakazo/ui-web";
import { ArrowUp, Square, X } from "lucide-react";
import type { ComponentProps, CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActiveBotGlyph } from "../../../components/ai/CollaborationMarker";
import { toolActivityPreference } from "../../../lib/chat/tool-activity-preference";
import { messageHasVisibleBlocks } from "../../../lib/chat/tool-activity-view";
import { transcriptIsNearEnd } from "../../../lib/chat/transcript-scroll";
import { composerEnterToSendPreference } from "../../../lib/composer/composer-enter-to-send-pref";
import type { SpaceQueries } from "../../../lib/query/query";
import { useSave } from "../../../lib/query/query";
import type { createSpaceRpc } from "../../../lib/query/rpc";
import { errorText } from "../../../lib/query/user-error";
import { MessageView } from "../chat/message-view";
import { useTopicThread } from "./use-topic-thread";

/** What the open chat hands its messages, shared with the thread's. */
export type ThreadMessageContext = Pick<
  ComponentProps<typeof MessageView>,
  | "onOpenBot"
  | "onOpenPeerMessages"
  | "peerBot"
  | "onBotChanged"
  | "onAddRoutine"
  | "onOpenComputer"
  | "onReleaseComputer"
  | "onOpenImportSetup"
>;

const noop = () => {};

/** One thread beside the chat: the message it replies to, its replies, and a reply box. */
export function ThreadPanel({
  rpc,
  queries,
  bot,
  topicId,
  topic,
  meId,
  messageContext,
  onClose,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  queries: SpaceQueries;
  bot: Bot;
  topicId: string;
  /** The thread as the Threads list has it; undefined until that list loads. */
  topic: TopicSummary | undefined;
  meId: string | undefined;
  messageContext: ThreadMessageContext;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const showToolActivity = toolActivityPreference.use();
  const enterToSend = composerEnterToSendPreference.use();
  const userBubble = useMemo(() => chatUserBubbleColors(bot.color, bot.id), [bot.color, bot.id]);
  const { snapshot, target, refresh } = useTopicThread({
    rpc,
    queries,
    botId: bot.id,
    topicId,
  });
  const threadKey = queries.threads.get.queryKey({ input: target });
  const topicsKey = queries.threads.topics.queryKey({ input: { botId: bot.id } });
  const [draft, setDraft] = useState("");

  const settle = useSave({
    save: (done: boolean, client) => client.threads.settleTopic({ ...target, done }),
    stale: [topicsKey],
  });
  const send = useSave({
    save: (text: string, client) =>
      client.threads.send({ ...target, text, clientNonce: newClientId() }),
    stale: [threadKey, topicsKey],
    onSaved: () => setDraft(""),
  });
  const stop = useSave({
    save: (_input, client) => client.threads.stop(target),
    stale: [threadKey],
  });

  const runs = activeThreadRuns(snapshot);
  const working = runs.some((run) => isRunWorking(run.status));
  const running = runs.some((run) => isActive(run.status));
  const messages = useMemo(() => {
    const visible = projectMessageReactions(snapshot?.messages ?? []).visibleMessages;
    return visible.filter((message) => messageHasVisibleBlocks(message.blocks, showToolActivity));
  }, [snapshot?.messages, showToolActivity]);
  const answerable = useMemo(() => answerableAskMessageIds(snapshot, meId), [snapshot, meId]);
  const dismissable = useMemo(() => dismissableAskMessageIds(snapshot, meId), [snapshot, meId]);
  const separateAnswers = useMemo(() => separateAskAnswers(messages), [messages]);
  const replyCount =
    topic?.replyCount ?? messages.filter((message) => !message.id.startsWith("progress:")).length;

  const answer = useCallback(
    async (
      message: ThreadMessage,
      text: string,
      fields?: LoginFieldInput[],
      dismiss?: boolean,
      remember?: false,
    ) => {
      await rpc.threads.answer({
        ...target,
        runId: message.runId ?? "",
        messageId: message.id,
        answer: text,
        ...(fields ? { fields } : {}),
        ...(remember === false ? { remember } : {}),
        ...(dismiss ? { dismiss: true as const } : {}),
      });
      // The answer is saved; the live stream catches up a failed read.
      await refresh().catch(() => undefined);
    },
    [rpc, target],
  );
  const refreshThread = useCallback(async () => {
    await refresh();
  }, [target]);

  // Follows new replies while the reader is at the end, as the chat does.
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [messages, working, snapshot?.topicRoot]);

  function submit() {
    const text = draft.trim();
    if (!text || send.pending) return;
    following.current = true;
    send.run(text);
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const sends = enterToSend ? !event.shiftKey : event.metaKey || event.ctrlKey;
    if (!sends) return;
    event.preventDefault();
    submit();
  }

  const root = snapshot?.topicRoot;
  const botMember = { botId: bot.id, name: bot.name, color: bot.color, avatarSet: bot.avatarSet };
  const messageProps = {
    ...messageContext,
    meId,
    rpc,
    showToolActivity,
    onAnswer: answer,
    onRefresh: refreshThread,
    voiceReady: false,
    speaking: false,
    callHoldsSpeaker: false,
    onSpeak: noop,
  };

  return (
    <div
      data-testid="thread-panel"
      className="flex h-full w-full flex-col"
      // The bot's colors on the person's own bubbles, as in its chat.
      style={
        userBubble
          ? ({
              "--chat-user": userBubble.background,
              "--chat-user-foreground": userBubble.foreground,
            } as CSSProperties)
          : undefined
      }
    >
      <div className="flex items-center gap-1 px-5 pt-[17px] pb-2">
        <SectionHeading as="h2" className="me-auto">
          <Trans>Thread</Trans>
        </SectionHeading>
        {topic ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={settle.pending}
            onClick={() => settle.run(topic.settledBy === null)}
          >
            {topic.settledBy === null ? <Trans>Done</Trans> : <Trans>Reopen</Trans>}
          </Button>
        ) : null}
        <Button variant="ghost" size="icon-sm" aria-label={t`Close panel`} onClick={onClose}>
          <X size={16} strokeWidth={1.8} />
        </Button>
      </div>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          following.current = transcriptIsNearEnd(event.currentTarget);
        }}
        className="rk-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-5 pb-4"
      >
        {root ? (
          <ThreadRow message={root}>
            <MessageView
              {...messageProps}
              message={root}
              artifactTarget={{ botId: bot.id }}
              canAnswer={false}
              canDismiss={false}
            />
          </ThreadRow>
        ) : null}
        {root ? (
          <div className="my-1 flex items-center gap-2 text-body-sm text-muted-foreground">
            <span>{t`${plural(replyCount, { one: "# reply", other: "# replies" })}`}</span>
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
          </div>
        ) : null}
        {messages.map((message) => (
          <ThreadRow key={message.id} message={message}>
            <MessageView
              {...messageProps}
              message={message}
              artifactTarget={target}
              separateAnswers={separateAnswers.get(message.id)}
              canAnswer={answerable.has(message.id)}
              canDismiss={dismissable.has(message.id)}
            />
          </ThreadRow>
        ))}
        {working &&
        !messages.some(
          (message) => message.id.startsWith("progress:") && liveMessageComposing(message.blocks),
        ) ? (
          <ActiveBotGlyph bots={[botMember]} label={liveActivityLine(messages) ?? t`Working…`} />
        ) : null}
      </div>
      <div className="px-3 pb-3">
        {send.error ? (
          <p role="alert" className="px-2 pb-1.5 text-body-sm text-destructive">
            {errorText(send.error)}
          </p>
        ) : null}
        <div className="flex items-end gap-2 rounded-2xl bg-muted p-1.5 ps-3">
          <Textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              send.reset();
            }}
            onKeyDown={onKeyDown}
            placeholder={t`Reply…`}
            aria-label={t`Reply in thread`}
            rows={1}
            className="max-h-40 min-h-8 flex-1 resize-none border-0 bg-transparent px-0 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          {running ? (
            <Button
              variant="outline"
              size="icon"
              aria-label={t`Stop`}
              disabled={stop.pending}
              onClick={() => stop.run()}
              className="shrink-0 rounded-full"
            >
              <Square size={11} strokeWidth={0} fill="currentColor" />
            </Button>
          ) : null}
          <Button
            size="icon"
            aria-label={t`Send`}
            disabled={!draft.trim() || send.pending}
            onClick={submit}
            className="shrink-0 rounded-full"
          >
            <ArrowUp size={16} strokeWidth={2.2} />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A message laid out as the chat lays it out, at the panel's width. */
function ThreadRow({ message, children }: { message: ThreadMessage; children: ReactNode }) {
  const wide = message.blocks.some(
    (block) =>
      block.kind === "ask" ||
      block.kind === "mcp_approval" ||
      block.kind === "tool_question" ||
      block.kind === "app_connect" ||
      block.kind === "page" ||
      block.kind === "computer",
  );
  return (
    <div
      data-message-id={message.id}
      className={cn(
        "group/message relative flex hover:z-[1]",
        message.role === "user" ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "relative min-w-0",
          wide ? "w-full" : "w-fit",
          message.role === "user" ? "max-w-[85%]" : "max-w-full",
        )}
      >
        {children}
      </div>
    </div>
  );
}
