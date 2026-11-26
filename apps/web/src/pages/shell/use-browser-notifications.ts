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

function eventRunOwner(event: {
  payload: Record<string, unknown>;
}): { userId: string } | undefined {
  return typeof event.payload.runUserId === "string" && event.payload.runUserId.length > 0
    ? { userId: event.payload.runUserId }
    : undefined;
}

function isQuestionOnlyEvent(event: { type: string; payload: { blocks?: unknown } }): boolean {
  if (event.type !== "thread.message.created") return false;
  const blocks = event.payload.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  return blocks.every((block) => isWaitingAskBlock(block));
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
  const runOwnersRef = useRef(new Map<string, { threadId: string; userId?: string }>());
  const liveRunFor = useCallback(
    (runId: string | undefined, threadId: string) => {
      if (!runId) return undefined;
      const snap = snapshotRef?.current;
      const snapRun =
        snap && snap.threadId === threadId
          ? activeThreadRuns(snap).find((candidate) => candidate.id === runId)
          : undefined;
      const streamRun = runOwnersRef.current.get(runId);
      const matchingStreamRun = streamRun?.threadId === threadId ? streamRun : undefined;
      if (snapRun) {
        return !snapRun.userId && matchingStreamRun?.userId
          ? { ...snapRun, userId: matchingStreamRun.userId }
          : snapRun;
      }
      return matchingStreamRun;
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
      event: {
        type: string;
        threadId: string;
        runId?: string;
        payload: Record<string, unknown> & { blocks?: unknown };
      },
      rememberedRunOwner?: { userId?: string },
    ): boolean => {
      if (event.type !== "thread.message.created") return false;
      const blocks = event.payload.blocks;
      if (!Array.isArray(blocks)) return false;
      const me = meIdRef.current;
      const run =
        eventRunOwner(event) ?? liveRunFor(event.runId, event.threadId) ?? rememberedRunOwner;
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
  const lastActiveChat = useRef<{ botId?: string; groupId?: string }>({
    botId: activeBotId.current,
    groupId: activeGroupId.current,
  });
  if (
    lastActiveChat.current.botId !== activeBotId.current ||
    lastActiveChat.current.groupId !== activeGroupId.current
  ) {
    const left = lastActiveChat.current;
    for (const [key, pending] of pendingBrowserNotifications.current) {
      if (!pending.questionOnly) continue;
      const belongedToLeft = left.groupId
        ? pending.groupId === left.groupId
        : !pending.groupId && left.botId !== undefined && pending.botId === left.botId;
      if (belongedToLeft) pendingBrowserNotifications.current.delete(key);
    }
    lastActiveChat.current = {
      botId: activeBotId.current,
      groupId: activeGroupId.current,
    };
  }
  const dropPendingQuestions = useCallback((threadId: string) => {
    for (const [key, pending] of pendingBrowserNotifications.current) {
      if (pending.questionOnly && pending.event.threadId === threadId) {
        pendingBrowserNotifications.current.delete(key);
      }
    }
    for (const [runId, owner] of runOwnersRef.current) {
      if (owner.threadId === threadId) runOwnersRef.current.delete(runId);
    }
  }, []);
  const syncPendingFromSnapshot = useCallback(
    (threadId?: string) => {
      const snap = snapshotRef?.current;
      const snapRuns = snap ? activeThreadRuns(snap) : undefined;
      for (const [key, pending] of pendingBrowserNotifications.current) {
        if (threadId !== undefined && pending.event.threadId !== threadId) continue;
        if (pending.event.runId) {
          const live =
            snap && snap.threadId === pending.event.threadId
              ? snapRuns?.find((candidate) => candidate.id === pending.event.runId)
              : undefined;
          const streamOwner = runOwnersRef.current.get(pending.event.runId);
          const ownerUserId =
            live?.userId ??
            (streamOwner?.threadId === pending.event.threadId ? streamOwner.userId : undefined);
          if (live || (streamOwner && streamOwner.threadId === pending.event.threadId)) {
            pending.runOwner = { userId: ownerUserId };
          }
        }
        if (pending.questionOnly && snap && snap.threadId === pending.event.threadId) {
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
      runOwnersRef.current.clear();
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
      // Drop a queued question-only card once it has expired or settled.
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
      if ((event.type === "run.started" || event.type === "run.waiting_input") && event.runId) {
        const userId =
          typeof event.payload.userId === "string" && event.payload.userId.length > 0
            ? event.payload.userId
            : undefined;
        const previous = runOwnersRef.current.get(event.runId);
        const ownerUserId =
          userId ?? (previous?.threadId === event.threadId ? previous.userId : undefined);
        runOwnersRef.current.set(event.runId, {
          threadId: event.threadId,
          ...(ownerUserId ? { userId: ownerUserId } : {}),
        });
      }
      syncPendingFromSnapshot(event.threadId);
      // Clearing a thread removes all queued alerts; settling a card or ending a run drops its question.
      if (event.type === "thread.cleared") {
        for (const [key, queued] of pendingBrowserNotifications.current) {
          if (queued.event.threadId === event.threadId) {
            pendingBrowserNotifications.current.delete(key);
          }
        }
        for (const [runId, owner] of runOwnersRef.current) {
          if (owner.threadId === event.threadId) runOwnersRef.current.delete(runId);
        }
      } else if (event.type === "thread.message.updated") {
        const messageId = eventMessageId(event);
        if (
          messageId !== undefined &&
          !(Array.isArray(event.payload.blocks) && event.payload.blocks.some(isWaitingAskBlock))
        ) {
          for (const [key, queued] of pendingBrowserNotifications.current) {
            if (
              queued.event.threadId === event.threadId &&
              eventMessageId(queued.event) === messageId
            ) {
              if (queued.questionOnly) {
                pendingBrowserNotifications.current.delete(key);
              } else if (Array.isArray(event.payload.blocks)) {
                queued.event = {
                  ...queued.event,
                  payload: { ...queued.event.payload, blocks: event.payload.blocks },
                };
              }
            }
          }
        }
      } else if (isRunTerminalEvent(event) && event.runId) {
        runOwnersRef.current.delete(event.runId);
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
      const runOwner = eventRunOwner(event) ?? liveRunFor(event.runId, event.threadId);
      const pending = {
        event,
        botId,
        botName,
        groupId,
        questionOnly: isQuestionOnlyEvent(event),
        ...(runOwner ? { runOwner: { userId: runOwner.userId } } : {}),
      } satisfies PendingBrowserNotification;
      const waits = questionWaitsOnViewer(event, pending.runOwner);
      // Ordinary replies wait out a snooze. A question still comes through, and a reply that was
      // queued before the snooze is checked again when it is actually shown.
      if (snoozedOrdinaryReply(event, chatFor(pending), () => waits)) return;
      if (typeof Notification === "undefined" || Notification.permission === "denied") return;
      const tag = browserNotificationTag(event, { waitingQuestion: waits });
      // Keep waiting questions separate per run while queued so a background helper's ask card
      // arriving before run.waiting_input cannot overwrite the viewer's own queued ask.
      const pendingKey = waits ? `${tag}:${event.runId ?? event.id}` : tag;
      if (Notification.permission === "default") {
        pendingBrowserNotifications.current.set(pendingKey, pending);
        return;
      }
      if (deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(pendingKey);
      } else {
        pendingBrowserNotifications.current.set(pendingKey, pending);
      }
    },
    [deliverBrowserNotification, liveRunFor, questionWaitsOnViewer, syncPendingFromSnapshot],
  );
  return { notifyBrowserForEvent, flushPendingBrowserNotifications, dropPendingQuestions };
}
