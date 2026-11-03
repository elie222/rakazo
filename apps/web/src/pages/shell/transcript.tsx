import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import type {
  BotAvatarSet,
  LoginFieldInput,
  MessageReaction,
  ThreadMessage,
} from "@rakazo/contracts";
import type { FoldedTranscript } from "@rakazo/core";
import {
  expandPeerReplies,
  groupVoiceChats,
  isPeerReceiptBlocks,
  liveActivityLine,
  liveMessageComposing,
  peerExchangeLines,
  projectBotMentions,
  projectMessageReactions,
  timeSeparatorIds,
  unreadDividerMessageId,
  voiceChatHoldsMessage,
} from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { Button, cn, Spinner } from "@rakazo/ui-web";
import { ArrowDown } from "lucide-react";
import type { CSSProperties, RefObject } from "react";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActiveBotGlyph } from "../../components/ai/CollaborationMarker";
import { VoiceChatCard } from "../../components/call/VoiceChatCard";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { quoteDraftForSelection } from "../../lib/quote-selection";
import { messageHasVisibleBlocks } from "../../lib/tool-activity-view";
import { TRANSCRIPT_CONTENT_PADDING } from "../../lib/transcript-layout";
import { transcriptIsNearEnd, transcriptMovedDown } from "../../lib/transcript-scroll";
import { TimeSeparator, UnreadDivider } from "./chat-context";
import type { ImportSetupTarget } from "./import-setup-card";
import { MessageView } from "./message-view";
import { QuoteSelectionButton } from "./quote-selection-button";

/** Bubbles stop at a readable line length instead of stretching with wide windows. */
export function bubbleFrameWidth(role: ThreadMessage["role"]) {
  return role === "user"
    ? "max-w-[min(84%,calc(100%_-_8rem),39rem)] [@media(hover:none)]:max-w-[min(84%,39rem)]"
    : "max-w-[min(88%,calc(100%_-_8rem),39rem)] [@media(hover:none)]:max-w-[min(88%,39rem)]";
}

export const Transcript = memo(function Transcript({
  scrollRef,
  scrollRequest,
  onScrollRequestHandled,
  artifactTarget,
  transcript,
  showToolActivity,
  olderCursor,
  unreadAfterSeq,
  loadingOlder,
  answerableAskIds,
  dismissableAskIds,
  running,
  workingBots,
  userBubble,
  onCallBack,
  onLoadOlder,
  onOpenBot,
  onAnswer,
  onReply,
  onMarkUnread,
  markedUnreadMessageId,
  onQuote,
  onReact,
  onJumpToMessage,
  onOpenPeerMessages,
  memberName,
  peerBot,
  onRefresh,
  onBotChanged,
  onAddRoutine,
  voiceReady,
  speakingMessageId,
  onSpeak,
  onOpenComputer,
  onOpenImportSetup,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollRequest: { messageId: string; nonce: number } | null;
  onScrollRequestHandled: () => void;
  artifactTarget: ArtifactTarget;
  transcript: FoldedTranscript<ThreadMessage>;
  showToolActivity: boolean;
  olderCursor: number | null;
  /** The seq read up to when this chat opened; null when nothing was unread. */
  unreadAfterSeq: number | null;
  loadingOlder: boolean;
  answerableAskIds: Set<string>;
  dismissableAskIds: Set<string>;
  running: boolean;
  workingBots: GroupAvatarMember[];
  /** Your bubbles take the bot's color in its own chat. */
  userBubble?: { background: string; foreground: string };
  /** Calls the bot back from a missed call in the transcript. */
  onCallBack?: () => void;
  onLoadOlder: () => void | Promise<void>;
  onOpenBot: (botId: string) => void;
  onAnswer: (
    message: ThreadMessage,
    text: string,
    fields?: LoginFieldInput[],
    dismiss?: boolean,
    remember?: false,
  ) => Promise<void>;
  onReply: (message: ThreadMessage) => void;
  onMarkUnread: (message: ThreadMessage) => void;
  markedUnreadMessageId?: string;
  onQuote: (message: ThreadMessage, quote: string) => void;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
  onJumpToMessage: (messageId: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (
    botId: string,
  ) => { name?: string; color: string; status?: string; avatarSet?: BotAvatarSet } | undefined;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speakingMessageId: string | null;
  onSpeak: (message: ThreadMessage) => void;
  onOpenComputer: (botId?: string) => void;
  onOpenImportSetup?: (target: ImportSetupTarget) => void;
}) {
  const { t } = useLingui();
  const [atEnd, setAtEnd] = useState(true);
  const following = useRef(true);
  const autoScrolling = useRef(false);
  const lastScrollTop = useRef<number | null>(null);
  const autoScrollTimer = useRef<number | undefined>(undefined);
  const jumpButtonRef = useRef<HTMLButtonElement>(null);
  const [expandedPeerMarkers, setExpandedPeerMarkers] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // A jump to a folded reply expands its marker; the scroll effect below then finds the row.
  useLayoutEffect(() => {
    const markerId = scrollRequest && transcript.markerOf.get(scrollRequest.messageId);
    if (!markerId) return;
    setExpandedPeerMarkers((expanded) =>
      expanded.has(markerId) ? expanded : new Set(expanded).add(markerId),
    );
  }, [scrollRequest, transcript]);
  const messages = useMemo(
    () => expandPeerReplies(transcript, expandedPeerMarkers),
    [transcript, expandedPeerMarkers],
  );
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const mentionView = useMemo(() => projectBotMentions(messages), [messages]);
  const jumpToMessage = useCallback(
    (messageId: string) => onJumpToMessage(mentionView.foldedInto.get(messageId) ?? messageId),
    [mentionView, onJumpToMessage],
  );
  const reactionView = useMemo(
    () => projectMessageReactions(mentionView.visibleMessages),
    [mentionView],
  );
  const visibleReceipts = reactionView.visibleMessages.filter((message) =>
    messageHasVisibleBlocks(message.blocks, showToolActivity),
  );
  const exchanges = peerExchangeLines({ ...transcript, messages: visibleReceipts });
  const shownMessages = visibleReceipts.filter(
    (message) => !exchanges.lineOf.has(message.id) || exchanges.lines.has(message.id),
  );
  const separatorIds = timeSeparatorIds(shownMessages);
  const unreadDividerId = unreadDividerMessageId(shownMessages, unreadAfterSeq, olderCursor);
  const workingLabel = liveActivityLine(messages) ?? t`Working…`;
  const [quoteDraft, setQuoteDraft] = useState<{
    message: ThreadMessage;
    text: string;
    range: Range;
  } | null>(null);
  const selectingWithMouse = useRef(false);

  const evaluateSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setQuoteDraft(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const contentOf = (node: Node) =>
      (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
        "[data-quote-message-id]",
      ) ?? null;
    const startContent = contentOf(range.startContainer);
    const endContent = contentOf(range.endContainer);
    // selection.toString() serializes the whole range (a Ctrl+A transcript is
    // unbounded), so it only runs once both endpoints sit in one message.
    const draft = quoteDraftForSelection(
      {
        startContent,
        endContent,
        text: startContent && startContent === endContent ? selection.toString() : "",
      },
      messageById,
    );
    setQuoteDraft((prev) => {
      if (!draft) return null;
      // Repeat firings for an unchanged selection reuse the draft so the
      // transcript isn't re-rendered by every unrelated selection event. A
      // moved selection (e.g. keyboard-selecting a second occurrence of the
      // same text) must carry its new Range — the pill anchors to it.
      if (
        prev &&
        prev.message === draft.message &&
        prev.text === draft.text &&
        prev.range.compareBoundaryPoints(Range.START_TO_START, range) === 0 &&
        prev.range.compareBoundaryPoints(Range.END_TO_END, range) === 0
      ) {
        return prev;
      }
      return { ...draft, range };
    });
  }, [messageById]);

  // Keyboard and assistive-tech selections never reach a mouseup, so the pill
  // lifecycle listens on selectionchange; the mouse flag keeps it hidden while
  // a drag is still in flight.
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      selectingWithMouse.current = true;
      if ((event.target as Element | null)?.closest?.("[data-quote-selection]")) return;
      setQuoteDraft(null);
    };
    const onMouseUp = () => {
      selectingWithMouse.current = false;
      evaluateSelection();
    };
    const onSelectionChange = () => {
      if (!selectingWithMouse.current) evaluateSelection();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuoteDraft(null);
    };
    // A drag that ends outside the window never fires document mouseup; reset
    // the flag on blur so keyboard selections keep working afterwards.
    const onWindowBlur = () => {
      selectingWithMouse.current = false;
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [evaluateSelection]);
  const snapToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    following.current = true;
    autoScrolling.current = false;
    setAtEnd(true);
    element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
  }, [scrollRef]);

  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    following.current = true;
    autoScrolling.current = !reducedMotion;
    setAtEnd(true);
    element.scrollTo({
      top: element.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
    window.clearTimeout(autoScrollTimer.current);
    // Fallback only: onScroll clears autoScrolling once near-end is reached.
    autoScrollTimer.current = window.setTimeout(
      () => {
        autoScrolling.current = false;
      },
      reducedMotion ? 0 : 2_000,
    );
  }, [scrollRef]);

  const scrolledJump = useRef<number | null>(null);
  const jumpScrolling = useRef(false);
  const jumpScrollTimer = useRef<number | undefined>(undefined);
  const endJumpScroll = useCallback(() => {
    jumpScrolling.current = false;
    window.clearTimeout(jumpScrollTimer.current);
    scrollRef.current?.removeEventListener("scrollend", endJumpScroll);
  }, [scrollRef]);
  // A jump scroll must win over follow-the-tail: unfollow inside the commit
  // that mounts the row so a live commit cannot cancel the animation, keep
  // retrying while the pinned window is still rendering, and suppress the
  // near-end follow re-arm only for the jump's own scroll events — scrollend
  // (or user input interrupting it, which also fires scrollend) ends the
  // suppression, with the timeout as fallback when no scroll happens.
  useLayoutEffect(() => {
    if (!scrollRequest || scrolledJump.current === scrollRequest.nonce) return;
    const element = scrollRef.current;
    const row = element?.querySelector(
      `[data-message-id="${CSS.escape(exchanges.lineOf.get(scrollRequest.messageId) ?? scrollRequest.messageId)}"]`,
    );
    if (!element || !row) return;
    scrolledJump.current = scrollRequest.nonce;
    following.current = false;
    autoScrolling.current = false;
    jumpScrolling.current = true;
    element.addEventListener("scrollend", endJumpScroll, { once: true });
    window.clearTimeout(jumpScrollTimer.current);
    jumpScrollTimer.current = window.setTimeout(endJumpScroll, 2_000);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Streaming layout updates can interrupt a smooth jump before it reaches the row.
    row.scrollIntoView({ behavior: "auto", block: "center" });
    row.animate(
      reducedMotion
        ? [{ backgroundColor: "var(--muted)" }, { backgroundColor: "var(--muted)" }]
        : [
            { backgroundColor: "transparent" },
            { backgroundColor: "var(--muted)" },
            { backgroundColor: "transparent" },
          ],
      { duration: 1200 },
    );
    onScrollRequestHandled();
  }, [messages, scrollRequest, scrollRef, endJumpScroll, onScrollRequestHandled, exchanges.lineOf]);

  useLayoutEffect(() => {
    if (following.current) snapToEnd();
  }, [messages, running, snapToEnd]);

  useLayoutEffect(() => {
    const button = jumpButtonRef.current;
    if (atEnd && button && document.activeElement === button) {
      button.blur();
    }
  }, [atEnd]);

  const loadOlder = useCallback(() => {
    const wasFollowing = following.current;
    // Prepend must not race the messages-driven snap-to-end follow path.
    following.current = false;
    autoScrolling.current = false;
    const pending = onLoadOlder();
    if (!pending) return;
    return Promise.resolve(pending).catch((error) => {
      const element = scrollRef.current;
      if (wasFollowing && element && transcriptIsNearEnd(element)) {
        following.current = true;
        setAtEnd(true);
      }
      throw error;
    });
  }, [onLoadOlder, scrollRef]);

  useEffect(
    () => () => {
      window.clearTimeout(autoScrollTimer.current);
      window.clearTimeout(jumpScrollTimer.current);
    },
    [],
  );

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-testid="transcript"
        onPointerDown={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
        }}
        onTouchStart={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) {
            lastScrollTop.current = event.currentTarget.scrollTop;
            autoScrolling.current = false;
            following.current = false;
          }
        }}
        onScroll={(event) => {
          const scrolledDown = transcriptMovedDown(
            lastScrollTop.current,
            event.currentTarget.scrollTop,
          );
          lastScrollTop.current = event.currentTarget.scrollTop;
          const nearEnd = transcriptIsNearEnd(event.currentTarget);
          setAtEnd(nearEnd);
          // A jump scroll owns the viewport until its animation settles; its
          // own near-end crossings must not re-arm tail-following.
          if (jumpScrolling.current) return;
          if (nearEnd) {
            if (scrolledDown) following.current = true;
            if (autoScrolling.current) {
              autoScrolling.current = false;
              window.clearTimeout(autoScrollTimer.current);
            }
          } else if (!autoScrolling.current) {
            following.current = false;
          }
        }}
        className={`rk-scroll isolate flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto scroll-pt-16 scroll-pb-7 pt-20 pb-12 md:pt-[84px] md:pb-13 ${TRANSCRIPT_CONTENT_PADDING}`}
        style={
          userBubble
            ? ({
                "--chat-user": userBubble.background,
                "--chat-user-foreground": userBubble.foreground,
              } as CSSProperties)
            : undefined
        }
      >
        {olderCursor != null ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
            aria-label={t`Load earlier messages`}
            className="self-center text-muted-foreground"
          >
            {loadingOlder ? <Spinner aria-label={t`Loading…`} /> : null}
            {t`Load earlier messages`}
          </Button>
        ) : null}
        {groupVoiceChats(reactionView.visibleMessages).map((item) => {
          if (item.kind === "voiceChat") {
            return (
              <div key={item.key}>
                {item.messages[0] && separatorIds.has(item.messages[0].id) ? (
                  <TimeSeparator
                    createdAt={item.messages[0].createdAt}
                    locale={i18n.locale || "en"}
                  />
                ) : null}
                {voiceChatHoldsMessage(item, unreadDividerId) ? (
                  <UnreadDivider
                    afterSeparator={Boolean(
                      item.messages[0] && separatorIds.has(item.messages[0].id),
                    )}
                  />
                ) : null}
                <VoiceChatCard
                  group={item}
                  revealMessageId={scrollRequest?.messageId}
                  onCallBack={onCallBack}
                />
              </div>
            );
          }
          const message = item.message;
          if (!messageHasVisibleBlocks(message.blocks, showToolActivity)) return null;
          const peerReceipt = isPeerReceiptBlocks(message.blocks);
          const messageReactions = reactionView.reactions.get(message.id);
          return (
            <Fragment key={message.id}>
              {separatorIds.has(message.id) ? (
                <TimeSeparator createdAt={message.createdAt} locale={i18n.locale || "en"} />
              ) : null}
              {message.id === unreadDividerId ? (
                <UnreadDivider afterSeparator={separatorIds.has(message.id)} />
              ) : null}
              <div
                data-message-id={message.id}
                className={peerReceipt ? "relative py-0.5" : "group/message relative hover:z-[1]"}
              >
                <div
                  className={
                    peerReceipt
                      ? undefined
                      : `relative flex ${message.role === "user" ? "justify-end" : "justify-start"}`
                  }
                >
                  <div
                    data-testid={peerReceipt ? undefined : "message-bubble-frame"}
                    className={
                      peerReceipt
                        ? undefined
                        : message.blocks.some(
                              (block) => block.kind === "ask" || block.kind === "mcp_approval",
                            )
                          ? "relative w-full min-w-0 max-w-full"
                          : `relative ${message.blocks.some((block) => block.kind === "app_connect") ? "w-full" : "w-fit"} min-w-0 ${bubbleFrameWidth(message.role)}`
                    }
                  >
                    <MessageView
                      artifactTarget={artifactTarget}
                      message={message}
                      markedUnread={message.id === markedUnreadMessageId}
                      mentions={mentionView.mentions.get(message.id)}
                      canAnswer={answerableAskIds.has(message.id)}
                      canDismiss={dismissableAskIds.has(message.id)}
                      onOpenBot={onOpenBot}
                      onOpenPeerMessages={onOpenPeerMessages}
                      peerExchange={exchanges.lines.get(message.id)}
                      onAnswer={onAnswer}
                      speakerName={
                        peerReceipt
                          ? undefined
                          : message.role === "bot"
                            ? memberName?.(message.botId)
                            : undefined
                      }
                      memberName={memberName}
                      peerBot={peerBot}
                      replyParent={
                        message.replyToMessageId
                          ? messageById.get(message.replyToMessageId)
                          : undefined
                      }
                      onJumpToMessage={jumpToMessage}
                      onRefresh={onRefresh}
                      onBotChanged={onBotChanged}
                      onAddRoutine={onAddRoutine}
                      voiceReady={voiceReady}
                      speaking={speakingMessageId === message.id}
                      onSpeak={() => onSpeak(message)}
                      onOpenComputer={onOpenComputer}
                      onOpenImportSetup={onOpenImportSetup}
                      showToolActivity={showToolActivity}
                      onReply={onReply}
                      onMarkUnread={onMarkUnread}
                      onReact={onReact}
                    />
                  </div>
                </div>
                {!peerReceipt && messageReactions ? (
                  <div
                    data-testid="message-reactions"
                    className={cn(
                      "mt-1 flex flex-wrap gap-1",
                      message.role === "user" && "justify-end",
                    )}
                  >
                    {[...messageReactions].map(([emoji, count]) => (
                      <span
                        key={emoji}
                        className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
                      >
                        {emoji}
                        {count > 1 ? ` ${count}` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </Fragment>
          );
        })}
        {running &&
        !messages.some(
          (message) => message.id.startsWith("progress:") && liveMessageComposing(message.blocks),
        ) ? (
          <ActiveBotGlyph bots={workingBots} label={workingLabel} />
        ) : null}
      </div>
      {quoteDraft ? (
        <QuoteSelectionButton
          range={quoteDraft.range}
          onQuote={() => {
            onQuote(quoteDraft.message, quoteDraft.text);
            window.getSelection()?.removeAllRanges();
            setQuoteDraft(null);
          }}
        />
      ) : null}
      <Button
        ref={jumpButtonRef}
        variant="floating"
        size="icon-lg"
        aria-label={t`Jump to latest`}
        aria-hidden={atEnd}
        tabIndex={atEnd ? -1 : 0}
        onClick={jumpToLatest}
        className={`absolute bottom-11 left-1/2 z-20 -translate-x-1/2 shadow-md transition-[opacity,transform,background-color] duration-200 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none ${
          atEnd ? "pointer-events-none translate-y-2 opacity-0" : "translate-y-0 opacity-100"
        }`}
      >
        <ArrowDown strokeWidth={1.8} className="size-[17px]" />
      </Button>
    </div>
  );
});

/**
 * Floating Quote action anchored to the selection's bounding rect. Measures
 * itself after mount so it can flip below the selection when there is no room
 * above and stay clamped inside the viewport; re-anchors on scroll/resize.
 */
