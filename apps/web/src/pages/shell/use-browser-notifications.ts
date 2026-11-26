import type { Bot, ChatAlert, ProductEvent } from "@rakazo/contracts";
import { chatAlertNeedsAttention } from "@rakazo/contracts";
import { chatSnoozed, isWaitingAskBlock } from "@rakazo/core";
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
  /** The open chat's live runs, whose owners say whose question this chat waits on. */
  activeRunsRef?: RefObject<readonly { id: string; userId?: string }[]>;
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
    activeRunsRef,
    roster,
    notificationSounds,
  }: ChatAlertOptions,
) {
  const meIdRef = useRef(meId);
  meIdRef.current = meId;
  // The snooze exception speaks to the person a question waits on. Both ask cards and tool
  // questions are answered only by the run's own user. A tool question arrives while its run is
  // already active, so it counts only when the viewer owns that run. An ask card from a
  // background run can arrive before run.waiting_input adds the run to activeRuns, so an unknown
  // run still alerts while a known run counts only when the viewer owns it.
  const questionWaitsOnViewer = useCallback(
    (
      event: { type: string; runId?: string; payload: { blocks?: unknown } },
      rememberedRunOwner?: { userId?: string },
    ): boolean => {
      if (event.type !== "thread.message.created") return false;
      const blocks = event.payload.blocks;
      if (!Array.isArray(blocks)) return false;
      const me = meIdRef.current;
      const run =
        (event.runId
          ? activeRunsRef?.current?.find((candidate) => candidate.id === event.runId)
          : undefined) ?? rememberedRunOwner;
      const viewerOwnsRun = !!me && !!run && run.userId === me;
      return blocks.some(
        (block) =>
          isWaitingAskBlock(block) &&
          ((block as { kind?: unknown }).kind === "tool_question"
            ? viewerOwnsRun
            : !run || viewerOwnsRun),
      );
    },
    [activeRunsRef],
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
  for (const pending of pendingBrowserNotifications.current.values()) {
    const runId = pending.event.runId;
    if (!runId) continue;
    const live = activeRunsRef?.current?.find((candidate) => candidate.id === runId);
    if (live) pending.runOwner = { userId: live.userId };
  }
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
      const waitsOnViewer = (event: {
        type: string;
        runId?: string;
        payload: { blocks?: unknown };
      }) => questionWaitsOnViewer(event, pending.runOwner);
      // A reply queued while permission was pending can be snoozed before it is shown.
      if (snoozedOrdinaryReply(pending.event, chatFor(pending), waitsOnViewer)) return true;
      const result = deliverNativeBrowserNotification(
        pending.event,
        currentBot.name || pending.botName,
        {
          enabled: pending.groupId !== undefined || currentBot.notifyOnFinish,
          pageVisible: document.visibilityState === "visible",
          windowFocused: document.hasFocus(),
          permission: Notification.permission,
          notifiedEventIds: notifiedBrowserEvents.current,
          show: (title, body, tag) => {
            const icon = notificationIcon(currentBot);
            const notification = new Notification(title, {
              body,
              tag,
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
    [questionWaitsOnViewer],
  );
  const flushPendingBrowserNotifications = useCallback(() => {
    if (!mounted.current) return;
    for (const [threadId, pending] of pendingBrowserNotifications.current) {
      if (deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(threadId);
      }
    }
  }, [deliverBrowserNotification]);
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
      const botId = event.botId;
      if (typeof botId !== "string") return;
      // A question held for permission goes when its card settles: answered or expired
      // elsewhere, the alert would arrive after the fact.
      if (event.type === "thread.message.updated") {
        const queued = pendingBrowserNotifications.current.get(`${event.threadId}:ask`);
        const messageId = eventMessageId(event);
        if (
          queued &&
          messageId !== undefined &&
          eventMessageId(queued.event) === messageId &&
          !(Array.isArray(event.payload.blocks) && event.payload.blocks.some(isWaitingAskBlock))
        ) {
          pendingBrowserNotifications.current.delete(`${event.threadId}:ask`);
        }
      }
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
      const liveRun = event.runId
        ? activeRunsRef?.current?.find((candidate) => candidate.id === event.runId)
        : undefined;
      const pending = {
        event,
        botId,
        botName,
        groupId,
        ...(liveRun ? { runOwner: { userId: liveRun.userId } } : {}),
      } satisfies PendingBrowserNotification;
      // Ordinary replies wait out a snooze. A question still comes through, and a reply that was
      // queued before the snooze is checked again when it is actually shown.
      if (snoozedOrdinaryReply(event, chatFor(pending), questionWaitsOnViewer)) return;
      if (typeof Notification === "undefined" || Notification.permission === "denied") return;
      if (Notification.permission === "default") {
        pendingBrowserNotifications.current.set(browserNotificationTag(event), pending);
        return;
      }
      if (deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(browserNotificationTag(event));
      } else {
        pendingBrowserNotifications.current.set(browserNotificationTag(event), pending);
      }
    },
    [activeRunsRef, deliverBrowserNotification, questionWaitsOnViewer],
  );
  return { notifyBrowserForEvent, flushPendingBrowserNotifications };
}
