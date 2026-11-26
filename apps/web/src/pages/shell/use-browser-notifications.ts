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
  event: Pick<ProductEvent, "id" | "type" | "threadId" | "seq" | "runId" | "botId" | "payload">;
  botId: string;
  botName: string;
  groupId: string | undefined;
  /** True when the queued event was a question card without ordinary message text. */
  questionOnly: boolean;
  /** Run owner captured while the notification's chat was open, so switching chats before flush keeps ownership. */
  runOwner?: { userId?: string };
};

type QuestionOwnership = "none" | "viewer" | "other" | "pending";

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

function resolvedUserId(owner: { userId?: string } | undefined): string | undefined {
  return typeof owner?.userId === "string" && owner.userId.length > 0 ? owner.userId : undefined;
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
  /** Latest raw `threads.get` response per thread, separate from locally reduced or jumped UI snapshots. */
  const serverSnapshotRef = useRef<ThreadSnapshot | null>(null);
  const serverSnapshotForEvent = useCallback(
    (threadId: string, seq: number): ThreadSnapshot | undefined => {
      const serverSnap = serverSnapshotRef.current;
      if (
        !serverSnap ||
        serverSnap.threadId !== threadId ||
        typeof serverSnap.cursor !== "number" ||
        serverSnap.cursor < seq
      ) {
        return undefined;
      }
      return serverSnap;
    },
    [],
  );
  const runEndedInServerSnapshot = useCallback(
    (runId: string | undefined, threadId: string, seq: number): boolean => {
      if (!runId) return false;
      const serverSnap = serverSnapshotForEvent(threadId, seq);
      if (!serverSnap) return false;
      return !activeThreadRuns(serverSnap).some((candidate) => candidate.id === runId);
    },
    [serverSnapshotForEvent],
  );
  const liveRunOwnerFor = useCallback(
    (runId: string | undefined, threadId: string): { userId: string } | undefined => {
      if (!runId) return undefined;
      const serverSnap = serverSnapshotRef.current;
      const serverRun =
        serverSnap && serverSnap.threadId === threadId
          ? activeThreadRuns(serverSnap).find((candidate) => candidate.id === runId)
          : undefined;
      const serverUserId = resolvedUserId(serverRun);
      if (serverUserId) return { userId: serverUserId };
      const snap = snapshotRef?.current;
      const snapRun =
        snap && snap.threadId === threadId
          ? activeThreadRuns(snap).find((candidate) => candidate.id === runId)
          : undefined;
      const snapUserId = resolvedUserId(snapRun);
      if (snapUserId) return { userId: snapUserId };
      const streamRun = runOwnersRef.current.get(runId);
      const streamUserId = streamRun?.threadId === threadId ? resolvedUserId(streamRun) : undefined;
      return streamUserId ? { userId: streamUserId } : undefined;
    },
    [snapshotRef],
  );
  // The snooze exception speaks to the person a question waits on. Both ask cards and tool
  // questions are answered only by the run's own user. Current servers attach `runUserId` to
  // waiting ask/tool_question events; when an older worker omits it and no resolved `userId` is
  // known yet, hold delivery as `"pending"` until an owner arrives, a terminal event arrives, or
  // a fresh `threads.get` snapshot confirms the run has stopped.
  const questionOwnership = useCallback(
    (
      event: {
        type: string;
        threadId: string;
        seq: number;
        runId?: string;
        payload: Record<string, unknown> & { blocks?: unknown };
      },
      rememberedRunOwner?: { userId?: string },
    ): QuestionOwnership => {
      if (event.type !== "thread.message.created") return "none";
      const blocks = event.payload.blocks;
      if (!Array.isArray(blocks)) return "none";
      const waitingBlocks = blocks.filter(isWaitingAskBlock);
      if (waitingBlocks.length === 0) return "none";
      if (runEndedInServerSnapshot(event.runId, event.threadId, event.seq)) return "other";
      const me = meIdRef.current;
      const ownerUserId =
        resolvedUserId(eventRunOwner(event)) ??
        resolvedUserId(liveRunOwnerFor(event.runId, event.threadId)) ??
        resolvedUserId(rememberedRunOwner);
      if (ownerUserId) {
        return me && ownerUserId === me ? "viewer" : "other";
      }
      // An explicit `{ userId: undefined }` sentinel is recorded only after leaving the chat or
      // confirming the run stopped, so a mixed reply does not stay pending forever.
      if (rememberedRunOwner !== undefined) return "other";
      if (event.runId) return "pending";
      return waitingBlocks.some((block) => (block as { kind?: unknown }).kind !== "tool_question")
        ? "viewer"
        : "other";
    },
    [liveRunOwnerFor, runEndedInServerSnapshot],
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
      const belongedToLeft = left.groupId
        ? pending.groupId === left.groupId
        : !pending.groupId && left.botId !== undefined && pending.botId === left.botId;
      if (!belongedToLeft) continue;
      if (pending.questionOnly) {
        pendingBrowserNotifications.current.delete(key);
      } else if (!pending.runOwner && pending.event.runId) {
        // After leaving the chat its live run events stop, so do not leave a mixed reply pending forever.
        pending.runOwner = { userId: undefined };
      }
    }
    lastActiveChat.current = {
      botId: activeBotId.current,
      groupId: activeGroupId.current,
    };
  }
  const dropPendingQuestions = useCallback((threadId: string) => {
    for (const [key, pending] of pendingBrowserNotifications.current) {
      if (pending.event.threadId !== threadId) continue;
      if (pending.questionOnly) {
        pendingBrowserNotifications.current.delete(key);
      } else if (!pending.runOwner && pending.event.runId) {
        pending.runOwner = { userId: undefined };
      }
    }
    for (const [runId, owner] of runOwnersRef.current) {
      if (owner.threadId === threadId) runOwnersRef.current.delete(runId);
    }
    if (serverSnapshotRef.current?.threadId === threadId) {
      serverSnapshotRef.current = null;
    }
  }, []);
  const reconcilePendingEntry = useCallback(
    (pending: PendingBrowserNotification): "keep" | "drop" => {
      const serverSnap = serverSnapshotForEvent(pending.event.threadId, pending.event.seq);
      const uiSnap =
        snapshotRef?.current?.threadId === pending.event.threadId ? snapshotRef.current : undefined;
      if (pending.event.runId) {
        const resolved = liveRunOwnerFor(pending.event.runId, pending.event.threadId);
        if (resolved) {
          pending.runOwner = resolved;
        }
        if (
          runEndedInServerSnapshot(pending.event.runId, pending.event.threadId, pending.event.seq)
        ) {
          // A fresh `threads.get` snapshot at or past this event omits the run: stop or completion
          // already ended it even if the card block stayed marked pending.
          if (pending.questionOnly) return "drop";
          if (!pending.runOwner) pending.runOwner = { userId: undefined };
        }
      }
      const messageId = eventMessageId(pending.event);
      if (messageId !== undefined) {
        if (serverSnap) {
          const serverMessage = serverSnap.messages.find((candidate) => candidate.id === messageId);
          if (serverMessage) {
            if (!serverMessage.blocks.some(isWaitingAskBlock)) {
              if (pending.questionOnly) return "drop";
              pending.event = {
                ...pending.event,
                payload: { ...pending.event.payload, blocks: serverMessage.blocks },
              };
            }
            return "keep";
          }
          if (serverSnap.olderCursor === null || serverSnap.messages.length === 0) {
            // The raw `threads.get` response covers the whole thread (or is empty) at or past
            // this event without the message, confirming the thread was cleared.
            return "drop";
          }
        }
        if (uiSnap) {
          const uiMessage = uiSnap.messages.find((candidate) => candidate.id === messageId);
          if (uiMessage && !uiMessage.blocks.some(isWaitingAskBlock)) {
            if (pending.questionOnly) return "drop";
            pending.event = {
              ...pending.event,
              payload: { ...pending.event.payload, blocks: uiMessage.blocks },
            };
          }
        }
      }
      return "keep";
    },
    [liveRunOwnerFor, runEndedInServerSnapshot, serverSnapshotForEvent, snapshotRef],
  );
  const syncPendingFromSnapshot = useCallback(
    (threadId?: string) => {
      for (const [key, pending] of pendingBrowserNotifications.current) {
        if (threadId !== undefined && pending.event.threadId !== threadId) continue;
        if (reconcilePendingEntry(pending) === "drop") {
          pendingBrowserNotifications.current.delete(key);
        }
      }
    },
    [reconcilePendingEntry],
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
      serverSnapshotRef.current = null;
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
      if (reconcilePendingEntry(pending) === "drop") return true;
      // Drop a queued question-only card once it has expired or settled.
      if (pending.questionOnly) {
        const blocks = pending.event.payload.blocks;
        if (!Array.isArray(blocks) || !blocks.some(isWaitingAskBlock)) return true;
      }
      const ownership = questionOwnership(pending.event, pending.runOwner);
      if (ownership === "pending") return false;
      const waits = ownership === "viewer";
      // A reply queued while permission was pending can be snoozed before it is shown.
      if (snoozedOrdinaryReply(pending.event, chatFor(pending), () => waits)) return true;
      const tag = browserNotificationTag(pending.event, {
        waitingQuestion: waits,
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
    [questionOwnership, reconcilePendingEntry],
  );
  const flushReadyNotifications = useCallback(
    (threadId?: string) => {
      if (!mounted.current) return;
      syncPendingFromSnapshot(threadId);
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      for (const [key, pending] of pendingBrowserNotifications.current) {
        if (threadId !== undefined && pending.event.threadId !== threadId) continue;
        if (deliverBrowserNotification(pending)) {
          pendingBrowserNotifications.current.delete(key);
        }
      }
    },
    [deliverBrowserNotification, syncPendingFromSnapshot],
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
  const reconcileSnapshot = useCallback(
    (snap?: ThreadSnapshot | null) => {
      if (snap) {
        const prev = serverSnapshotRef.current;
        if (!prev || prev.threadId !== snap.threadId || snap.cursor >= prev.cursor) {
          serverSnapshotRef.current = snap;
        }
      }
      const targetThreadId = snap?.threadId ?? serverSnapshotRef.current?.threadId;
      flushReadyNotifications(targetThreadId);
    },
    [flushReadyNotifications],
  );
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
          if (queued.event.threadId !== event.threadId || queued.event.runId !== event.runId) {
            continue;
          }
          if (queued.questionOnly) {
            pendingBrowserNotifications.current.delete(key);
          } else if (!queued.runOwner) {
            queued.runOwner = { userId: undefined };
          }
        }
      }
      if (
        event.type === "run.started" ||
        event.type === "run.waiting_input" ||
        isRunTerminalEvent(event)
      ) {
        flushReadyNotifications(event.threadId);
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
      const runOwner = eventRunOwner(event) ?? liveRunOwnerFor(event.runId, event.threadId);
      const pending = {
        event,
        botId,
        botName,
        groupId,
        questionOnly: isQuestionOnlyEvent(event),
        ...(runOwner ? { runOwner } : {}),
      } satisfies PendingBrowserNotification;
      if (reconcilePendingEntry(pending) === "drop") return;
      const ownership = questionOwnership(pending.event, pending.runOwner);
      const waits = ownership === "viewer";
      // Ordinary replies wait out a snooze. A question still comes through, and a reply that was
      // queued before the snooze is checked again when it is actually shown.
      if (
        ownership !== "pending" &&
        snoozedOrdinaryReply(pending.event, chatFor(pending), () => waits)
      ) {
        return;
      }
      if (typeof Notification === "undefined" || Notification.permission === "denied") return;
      const hasWaitingAsk = ownership !== "none";
      const tag = browserNotificationTag(pending.event, { waitingQuestion: waits });
      // Queue waiting questions by message ID so parallel asks or tool questions from the same
      // run (or a foreign helper's card) never overwrite each other before display, while display
      // still shares the thread's `:ask` tag.
      const pendingKey = hasWaitingAsk
        ? `${pending.event.threadId}:ask:${eventMessageId(pending.event) ?? pending.event.id}`
        : tag;
      if (ownership === "pending" || Notification.permission === "default") {
        pendingBrowserNotifications.current.set(pendingKey, pending);
        return;
      }
      if (deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(pendingKey);
      } else {
        pendingBrowserNotifications.current.set(pendingKey, pending);
      }
    },
    [
      deliverBrowserNotification,
      flushReadyNotifications,
      liveRunOwnerFor,
      questionOwnership,
      reconcilePendingEntry,
      syncPendingFromSnapshot,
    ],
  );
  return {
    notifyBrowserForEvent,
    flushPendingBrowserNotifications,
    dropPendingQuestions,
    reconcileSnapshot,
  };
}
