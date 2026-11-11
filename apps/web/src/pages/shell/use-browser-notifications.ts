import type { Bot, ChatAlert, Group, ProductEvent } from "@rakazo/contracts";
import { isRetryableError, retryDelayMs } from "@rakazo/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef } from "react";
import {
  deliverBrowserNotification as deliverNativeBrowserNotification,
  shouldNotifyBrowser,
} from "../../lib/browser-notifications";
import { notificationIcon, prepareNotificationIcons } from "../../lib/notification-icon";
import type { RpcClient } from "../../lib/rpc";

type PendingBrowserNotification = {
  event: Pick<ProductEvent, "id" | "type" | "threadId" | "botId" | "payload">;
  botId: string;
  botName: string;
  groupId: string | undefined;
};

type ChatAlertOptions = {
  rpc: Pick<RpcClient, "notifications">;
  activeBotId: RefObject<string | undefined>;
  activeGroupId: RefObject<string | undefined>;
  openChat: (chat: Pick<ChatAlert, "botId" | "groupId">) => void;
  /** The signed-in person, whose own messages never notify them. */
  meId: string | undefined;
  /** The open space's groups as they are now, so a mute or hide holds back their notifications. */
  groupsRef: RefObject<Group[]>;
};

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
  { rpc, activeBotId, activeGroupId, openChat, meId, groupsRef }: ChatAlertOptions,
) {
  const meIdRef = useRef(meId);
  meIdRef.current = meId;
  useEffect(() => prepareNotificationIcons(bots), [bots]);
  const openChatRef = useRef(openChat);
  openChatRef.current = openChat;
  const shown = useRef(new Set<Notification>());
  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;
    let cancelRetry: (() => void) | undefined;
    const show = (alert: ChatAlert) => {
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      const isOpen = alert.groupId
        ? alert.groupId === activeGroupId.current
        : !activeGroupId.current && alert.botId === activeBotId.current;
      // The open chat's own stream alerts for its replies and failures; only a takeover is missed.
      // A muted or hidden chat's stream stays quiet, so the server's alerts, which for such a chat
      // are only the viewer's own questions, takeovers and failures, speak for it.
      const shownChat = !isOpen
        ? undefined
        : alert.groupId
          ? groupsRef.current.find((group) => group.id === alert.groupId)
          : botsRef.current.find((bot) => bot.id === alert.botId);
      const streamSpeaks = !shownChat?.muted && !shownChat?.hidden;
      if (
        isOpen &&
        ((alert.kind !== "takeover" && streamSpeaks) ||
          (document.visibilityState === "visible" && document.hasFocus()))
      )
        return;
      try {
        const bot = botsRef.current.find((candidate) => candidate.id === alert.botId);
        const icon = bot ? notificationIcon(bot) : undefined;
        const notification = new Notification(alert.title, {
          body: alert.body,
          ...(icon ? { icon } : {}),
          // Per chat and kind: a repeat replaces its copy, but a question after a reply still pops up.
          tag: `${alert.threadId}:${alert.kind}`,
        });
        openChatOnClick(notification, shown.current, () => openChatRef.current(alert));
      } catch {
        // Some browsers only allow notifications from a service worker.
      }
    };
    void (async () => {
      while (active) {
        controller = new AbortController();
        let failure: unknown;
        try {
          const stream = await rpc.notifications.subscribe(undefined, {
            signal: controller.signal,
          });
          for await (const frame of stream) {
            if (!active) return;
            if (frame.alert) show(frame.alert);
          }
        } catch (cause) {
          failure = cause;
        } finally {
          controller.abort();
        }
        if (!active || (failure !== undefined && !isRetryableError(failure))) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryDelayMs(failure, 1_000));
          cancelRetry = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        cancelRetry = undefined;
      }
    })();
    return () => {
      active = false;
      controller?.abort();
      cancelRetry?.();
      for (const notification of shown.current) notification.close();
    };
  }, [rpc]);
  const notifiedBrowserEvents = useRef(new Set<string>());
  const pendingBrowserNotifications = useRef(new Map<string, PendingBrowserNotification>());
  // A permission answer can arrive after the shell has gone; its held notifications go with it.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingBrowserNotifications.current.clear();
    };
  }, []);
  const deliverBrowserNotification = useCallback((pending: PendingBrowserNotification): boolean => {
    const currentBot = botsRef.current.find((bot) => bot.id === pending.botId);
    if (!currentBot || typeof Notification === "undefined") return true;
    // Read when it is shown, so a chat muted or hidden while permission was pending stays quiet.
    const chat =
      pending.groupId === undefined
        ? currentBot
        : groupsRef.current.find((group) => group.id === pending.groupId);
    const result = deliverNativeBrowserNotification(
      pending.event,
      currentBot.name || pending.botName,
      {
        enabled: Boolean(chat && !chat.muted && !chat.hidden),
        pageVisible: document.visibilityState === "visible",
        windowFocused: document.hasFocus(),
        permission: Notification.permission,
        notifiedEventIds: notifiedBrowserEvents.current,
        show: (title, body, tag) => {
          const icon = notificationIcon(currentBot);
          const notification = new Notification(title, { body, tag, ...(icon ? { icon } : {}) });
          openChatOnClick(notification, shown.current, () =>
            openChatRef.current({ botId: pending.botId, groupId: pending.groupId }),
          );
        },
      },
    );
    return result !== "pending";
  }, []);
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
      event: Pick<ProductEvent, "id" | "type" | "threadId" | "seq" | "botId" | "payload">,
      subscribedThreadId: string | undefined,
      initialCursor: number,
      streamReady: boolean,
      botName: string,
      groupId: string | undefined,
    ) => {
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
      if (!eligible) return;
      const pending = {
        event,
        botId,
        botName,
        groupId,
      } satisfies PendingBrowserNotification;
      if (typeof Notification === "undefined" || Notification.permission === "denied") return;
      if (Notification.permission === "default") {
        pendingBrowserNotifications.current.set(event.threadId, pending);
        return;
      }
      if (deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(event.threadId);
      } else {
        pendingBrowserNotifications.current.set(event.threadId, pending);
      }
    },
    [deliverBrowserNotification],
  );
  return { notifyBrowserForEvent, flushPendingBrowserNotifications };
}
