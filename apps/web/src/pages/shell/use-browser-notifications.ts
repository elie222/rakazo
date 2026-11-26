import type { Bot, ChatAlert, ProductEvent, ThreadSnapshot } from "@rakazo/contracts";
import { chatAlertNeedsAttention } from "@rakazo/contracts";
import { activeThreadRuns, chatSnoozed, isRunTerminalEvent, isWaitingAskBlock } from "@rakazo/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef } from "react";
import { computerUpdates } from "../../lib/computers/computer-updates";
import {
  browserNotificationTag,
  deliverBrowserNotification as deliverNativeBrowserNotification,
  shouldNotifyBrowser,
} from "../../lib/platform/browser-notifications";
import { desktopBridge } from "../../lib/platform/desktop";
import { notificationIcon, prepareNotificationIcons } from "../../lib/platform/notification-icon";
import { followStream } from "../../lib/query/follow-stream";
import type { RpcClient } from "../../lib/query/rpc";
import { isReadChangeKind, spaceChanged } from "../../lib/query/space-changes";
import { organizationsChanged } from "../../lib/spaces/organizations";

type PendingBrowserNotification = {
  event: Pick<ProductEvent, "id" | "type" | "threadId" | "runId" | "botId" | "payload">;
  botId: string;
  botName: string;
  groupId: string | undefined;
  /** True when the queued event was a question card without ordinary message text. */
  questionOnly: boolean;
  /** Run owner captured while the notification's chat was open, so switching chats before flush keeps ownership. */
  runOwner?: { userId?: string };
};

type SnoozableChat = { id: string; snoozedUntil?: string | null };

type ChatAlertOptions = {
  rpc: Pick<RpcClient, "notifications">;
  activeBotId: RefObject<string | undefined>;
  activeGroupId: RefObject<string | undefined>;
  openChat: (chat: Pick<ChatAlert, "botId" | "groupId">) => void;
  /** The signed-in person, whose own messages never notify them. */
  meId: string | undefined;
  notificationSounds?: boolean;
  /** Current groups, so a snooze that lands after a reply was queued is still honored. */
  groupsRef?: RefObject<readonly SnoozableChat[]>;
  /** The open chat's live snapshot, updated synchronously on every thread event before notifications run. */
  snapshotRef?: RefObject<ThreadSnapshot | null>;
  /** The server's roster signals: one when the stream opens, then one per change. */
  roster?: RosterSignals;
};

export type RosterSignals = { changed: () => void };

function eventMessageId(event: { payload: Record<string, unknown> }): string | undefined {
  return typeof event.payload.messageId === "string"
    ? event.payload.messageId
    : typeof event.payload.id === "string"
      ? event.payload.id
      : undefined;
}

function isQuestionOnlyEvent(event: { type: string; payload: { blocks?: unknown } }): boolean {
  if (event.type !== "thread.message.created") return false;
  const blocks = event.payload.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  let hasQuestion = false;
  for (const block of blocks) {
    if (!block || typeof block !== "object" || !("kind" in block)) return false;
    if (block.kind === "ask" || block.kind === "tool_question") {
      hasQuestion = true;
      continue;
    }
    return false;
  }
  return hasQuestion;
}

function snoozedOrdinaryReply(
  event: { type: string; runId?: string; payload: { blocks?: unknown } },
  chat: SnoozableChat | undefined,
  waitsOnViewer: (event: {
    type: string;
    runId?: string;
    payload: { blocks?: unknown };
  }) => boolean,
): boolean {
  return (
    event.type === "thread.message.created" &&
    !waitsOnViewer(event) &&
    !!chat &&
    chatSnoozed(chat, Date.now())
  );
}

// A click must not reach a shell that has gone, so the shell closes what it showed.
function openChatOnClick(
  notification: Notification,
  shown: Set<Notification>,
  openChat: () => void,
) {
  shown.add(notification);
  notification.onclose = () => shown.delete(notification);
  notification.onclick = () => {
    window.focus();
    openChat();
    notification.close();
  };
}

/**
 * Finished-run notifications for the open chat, held until the browser grants permission, and
 * the server's alerts for every other chat.
 */
export function useBrowserNotifications(
  bots: Bot[],
  botsRef: RefObject<Bot[]>,
  {
    rpc,
    activeBotId,
    activeGroupId,
    openChat,
    meId,
    groupsRef,
    snapshotRef,
    roster,
    notificationSounds,
  }: ChatAlertOptions,
) {
  const meIdRef = useRef(meId);
  meIdRef.current = meId;
  const liveRunFor = useCallback(
    (runId: string | undefined, threadId: string) => {
      if (!runId) return undefined;
      const snap = snapshotRef?.current;
      if (!snap || snap.threadId !== threadId) return undefined;
      return activeThreadRuns(snap).find((candidate) => candidate.id === runId);
    },
    [snapshotRef],
  );
  // The snooze exception speaks to the person a question waits on. Both ask cards and tool
  // questions are answered only by the run's own user. A tool question arrives while its run is
  // already active, so it counts only when the viewer owns that run. An ask card from a
  // background run can arrive before run.waiting_input adds the run to the live snapshot, so an
  // unknown run still alerts while a known run counts only when the viewer owns it.
  const questionWaitsOnViewer = useCallback(
    (
      event: { type: string; threadId: string; runId?: string; payload: { blocks?: unknown } },
      rememberedRunOwner?: { userId?: string },
    ): boolean => {
      if (event.type !== "thread.message.created") return false;
      const blocks = event.payload.blocks;
      if (!Array.isArray(blocks)) return false;
      const me = meIdRef.current;
      const run = liveRunFor(event.runId, event.threadId) ?? rememberedRunOwner;
      const viewerOwnsRun = !!me && !!run && run.userId === me;
      return blocks.some(
        (block) =>
          isWaitingAskBlock(block) &&
          ((block as { kind?: unknown }).kind === "tool_question"
            ? viewerOwnsRun
            : !run || viewerOwnsRun),
      );
    },
    [liveRunFor],
  );
  const soundEnabled = useRef(false);
  soundEnabled.current = notificationSounds === true;
  useEffect(() => prepareNotificationIcons(bots), [bots]);
  const openChatRef = useRef(openChat);
  openChatRef.current = openChat;
  const rosterRef = useRef(roster);
  rosterRef.current = roster;
  const shown = useRef(new Set<Notification>());
  useEffect(() => {
    const show = (alert: ChatAlert) => {
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      const isOpen = alert.groupId
        ? alert.groupId === activeGroupId.current
        : !activeGroupId.current && alert.botId === activeBotId.current;
      const desktop = Boolean(desktopBridge());
      const playSound = desktop && soundEnabled.current && chatAlertNeedsAttention(alert.kind);
      // Leave the open chat to its thread stream, except for takeovers and opted-in sounds
      // while the window is in the background. Only the server alert can request a sound.
      if (
        isOpen &&
        (!(alert.kind === "takeover" || playSound) ||
          (document.visibilityState === "visible" && document.hasFocus()))
      )
        return;
      // Reuse the thread stream's tag where both paths show this alert.
      const tag =
        isOpen && playSound && alert.kind === "failure"
          ? alert.threadId
          : `${alert.threadId}:${isOpen && playSound && alert.kind === "help" ? "ask" : alert.kind}`;
      try {
        const bot = botsRef.current.find((candidate) => candidate.id === alert.botId);
        const icon = bot ? notificationIcon(bot) : undefined;
        const notification = new Notification(alert.title, {
          body: alert.body,
          ...(icon ? { icon } : {}),
          // Per chat and kind: a repeat replaces its copy, but a question after a reply still pops up.
          tag,
          ...(desktop ? { silent: !playSound } : {}),
        });
        openChatOnClick(notification, shown.current, () => openChatRef.current(alert));
      } catch {
        // Some browsers only allow notifications from a service worker.
      }
    };
    const stop = followStream(
      (signal) => rpc.notifications.subscribe(undefined, { signal }),
      (frame) => {
        if (frame.type === "roster") rosterRef.current?.changed();
        else if (frame.type === "organizations") void organizationsChanged();
        else if (frame.type === "computerUpdates") computerUpdates.signalled();
        else if (isReadChangeKind(frame.type)) void spaceChanged(frame.type);
        else if (frame.alert) show(frame.alert);
      },
    );
    return () => {
      stop();
      for (const notification of shown.current) notification.close();
    };
  }, [rpc]);
  const notifiedBrowserEvents = useRef(new Set<string>());
  const pendingBrowserNotifications = useRef(new Map<string, PendingBrowserNotification>());
  const syncPendingFromSnapshot = useCallback(
    (threadId?: string) => {
      const snap = snapshotRef?.current;
      if (!snap || (threadId !== undefined && snap.threadId !== threadId)) return;
      const runs = activeThreadRuns(snap);
      for (const [key, pending] of pendingBrowserNotifications.current) {
        if (pending.event.threadId !== snap.threadId) continue;
        if (pending.event.runId) {
          const live = runs.find((candidate) => candidate.id === pending.event.runId);
          if (live) pending.runOwner = { userId: live.userId };
        }
        if (pending.questionOnly) {
          const messageId = eventMessageId(pending.event);
          const liveMessage =
            messageId !== undefined
              ? snap.messages.find((candidate) => candidate.id === messageId)
              : undefined;
          if (liveMessage && !liveMessage.blocks.some(isWaitingAskBlock)) {
            pendingBrowserNotifications.current.delete(key);
          }
        }
      }
    },
    [snapshotRef],
  );
  syncPendingFromSnapshot();
  // A permission answer can arrive after the shell has gone; its held notifications go with it.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingBrowserNotifications.current.clear();
    };
  }, []);
  const chatFor = (pending: PendingBrowserNotification): SnoozableChat | undefined =>
    pending.groupId
      ? groupsRef?.current.find((group) => group.id === pending.groupId)
      : botsRef.current.find((bot) => bot.id === pending.botId);
  const deliverBrowserNotification = useCallback(
    (pending: PendingBrowserNotification): boolean => {
      const currentBot = botsRef.current.find((bot) => bot.id === pending.botId);
      if (!currentBot || typeof Notification === "undefined") return true;
      // Drop a queued question-only card once it has expired or settled (including while away).
      if (pending.questionOnly) {
        const blocks = pending.event.payload.blocks;
        if (!Array.isArray(blocks) || !blocks.some(isWaitingAskBlock)) return true;
        const snap = snapshotRef?.current;
        if (snap && snap.threadId === pending.event.threadId) {
          const messageId = eventMessageId(pending.event);
          const liveMessage =
            messageId !== undefined
              ? snap.messages.find((candidate) => candidate.id === messageId)
              : undefined;
          if (liveMessage && !liveMessage.blocks.some(isWaitingAskBlock)) return true;
        }
      }
      const waitsOnViewer = (event: {
        type: string;
        runId?: string;
        payload: { blocks?: unknown };
      }) => questionWaitsOnViewer({ ...event, threadId: pending.event.threadId }, pending.runOwner);
      // A reply queued while permission was pending can be snoozed before it is shown.
      if (snoozedOrdinaryReply(pending.event, chatFor(pending), waitsOnViewer)) return true;
      const tag = browserNotificationTag(pending.event, {
        waitingQuestion: waitsOnViewer(pending.event),
      });
      const result = deliverNativeBrowserNotification(
        pending.event,
        currentBot.name || pending.botName,
        {
          enabled: pending.groupId !== undefined || currentBot.notifyOnFinish,
          pageVisible: document.visibilityState === "visible",
          windowFocused: document.hasFocus(),
          permission: Notification.permission,
          notifiedEventIds: notifiedBrowserEvents.current,
          tag,
          show: (title, body, notificationTag) => {
            const icon = notificationIcon(currentBot);
            const notification = new Notification(title, {
              body,
              tag: notificationTag,
              ...(icon ? { icon } : {}),
              ...(desktopBridge() ? { silent: true } : {}),
            });
            openChatOnClick(notification, shown.current, () =>
              openChatRef.current({ botId: pending.botId, groupId: pending.groupId }),
            );
          },
        },
      );
      return result !== "pending";
    },
    [questionWaitsOnViewer, snapshotRef],
  );
  const flushPendingBrowserNotifications = useCallback(() => {
    if (!mounted.current) return;
    syncPendingFromSnapshot();
    for (const [key, pending] of pendingBrowserNotifications.current) {
      if (deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(key);
      }
    }
  }, [deliverBrowserNotification, syncPendingFromSnapshot]);
  const notifyBrowserForEvent = useCallback(
    (
      event: Pick<ProductEvent, "id" | "type" | "threadId" | "seq" | "runId" | "botId" | "payload">,
      subscribedThreadId: string | undefined,
      initialCursor: number,
      streamReady: boolean,
      botName: string,
      enabled: boolean,
      groupId: string | undefined,
    ) => {
      syncPendingFromSnapshot(event.threadId);
      // A question held for permission goes when its card settles or its run ends.
      if (event.type === "thread.message.updated") {
        const messageId = eventMessageId(event);
        if (
          messageId !== undefined &&
          !(Array.isArray(event.payload.blocks) && event.payload.blocks.some(isWaitingAskBlock))
        ) {
          for (const key of [`${event.threadId}:ask`, event.threadId]) {
            const queued = pendingBrowserNotifications.current.get(key);
            if (queued && eventMessageId(queued.event) === messageId) {
              pendingBrowserNotifications.current.delete(key);
            }
          }
        }
      } else if (isRunTerminalEvent(event) && event.runId) {
        for (const [key, queued] of pendingBrowserNotifications.current) {
          if (
            queued.questionOnly &&
            queued.event.threadId === event.threadId &&
            queued.event.runId === event.runId
          ) {
            pendingBrowserNotifications.current.delete(key);
          }
        }
      }
      const botId = event.botId;
      if (typeof botId !== "string") return;
      const eligible = shouldNotifyBrowser(event, {
        subscribedThreadId: subscribedThreadId ?? "",
        initialCursor,
        streamReady,
        pageVisible: document.visibilityState === "visible",
        windowFocused: document.hasFocus(),
        permission: "granted",
        notifiedEventIds: notifiedBrowserEvents.current,
        meId: meIdRef.current,
      });
      if (!eligible || !enabled) return;
      const liveRun = liveRunFor(event.runId, event.threadId);
      const pending = {
        event,
        botId,
        botName,
        groupId,
        questionOnly: isQuestionOnlyEvent(event),
        ...(liveRun ? { runOwner: { userId: liveRun.userId } } : {}),
      } satisfies PendingBrowserNotification;
      const waits = questionWaitsOnViewer(event, pending.runOwner);
      // Ordinary replies wait out a snooze. A question still comes through, and a reply that was
      // queued before the snooze is checked again when it is actually shown.
      if (snoozedOrdinaryReply(event, chatFor(pending), () => waits)) return;
      if (typeof Notification === "undefined" || Notification.permission === "denied") return;
      const tag = browserNotificationTag(event, { waitingQuestion: waits });
      if (Notification.permission === "default") {
        pendingBrowserNotifications.current.set(tag, pending);
        return;
      }
      if (deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(tag);
      } else {
        pendingBrowserNotifications.current.set(tag, pending);
      }
    },
    [deliverBrowserNotification, liveRunFor, questionWaitsOnViewer, syncPendingFromSnapshot],
  );
  return { notifyBrowserForEvent, flushPendingBrowserNotifications };
}
