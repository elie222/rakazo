import type { Bot, ProductEvent } from "@rakazo/contracts";
import { isRunWaitingOnUser, isRunWorking, notificationAvatarSource } from "@rakazo/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { NavigateFunction } from "react-router-dom";
import {
  deliverBrowserNotification as deliverNativeBrowserNotification,
  shouldNotifyBrowser,
} from "../../lib/browser-notifications";

type PendingBrowserNotification = {
  event: Pick<ProductEvent, "id" | "type" | "threadId" | "botId" | "payload">;
  botId: string;
  botName: string;
  groupNotification: boolean;
  groupId?: string;
  allowForeground?: boolean;
};

/** Replies and interruptions, held until the browser grants permission. */
export function useBrowserNotifications(
  botsRef: RefObject<Bot[]>,
  bots: Bot[],
  openBotId: string | undefined,
  spaceId: string | undefined,
  navigate: NavigateFunction,
) {
  const previousRoster = useRef<{ spaceId: string | undefined; bots: Bot[] } | null>(null);
  const notifiedBrowserEvents = useRef(new Set<string>());
  const pendingBrowserNotifications = useRef(new Map<string, PendingBrowserNotification>());
  const deliverBrowserNotification = useCallback(
    (pending: PendingBrowserNotification): boolean => {
      const currentBot = botsRef.current.find((bot) => bot.id === pending.botId);
      if (!currentBot || typeof Notification === "undefined") return true;
      const result = deliverNativeBrowserNotification(
        pending.event,
        currentBot.name || pending.botName,
        {
          enabled: pending.groupNotification || currentBot.notifyOnFinish,
          allowForeground: pending.allowForeground && pending.botId !== openBotId,
          pageVisible: document.visibilityState === "visible",
          windowFocused: document.hasFocus(),
          permission: Notification.permission,
          notifiedEventIds: notifiedBrowserEvents.current,
          show: (title, body, tag) => {
            const notification = new Notification(title, {
              body,
              tag,
              icon: notificationAvatarSource(currentBot),
            });
            notification.onclick = () => {
              window.focus();
              if (pending.groupId) void navigate(`/app/g/${pending.groupId}`);
              else if (!pending.groupNotification) void navigate(`/app/${currentBot.id}`);
              notification.close();
            };
          },
        },
      );
      return result !== "pending";
    },
    [openBotId, navigate],
  );
  useEffect(() => {
    const previous = previousRoster.current;
    previousRoster.current = { spaceId, bots };
    if (!previous || previous.spaceId !== spaceId || !previous.bots.length) return;
    for (const bot of bots) {
      const before = previous.bots.find((entry) => entry.id === bot.id);
      if (!before || bot.id === openBotId || !bot.notifyOnFinish) continue;
      // Only the agent's own chat: preview, unread and runErrorId describe it, while status may
      // come from a group run, which that group's open stream announces instead.
      const failed = bot.unread && !!bot.runErrorId && bot.runErrorId !== before.runErrorId;
      const newMessage = bot.unread && bot.updatedAt !== before.updatedAt;
      const waiting = newMessage && isRunWaitingOnUser(bot.status);
      const interrupted = failed || waiting;
      const replied = !interrupted && newMessage && !isRunWorking(bot.status);
      if (!interrupted && !replied) continue;
      const event = {
        id: failed ? `roster:failed:${bot.runErrorId}` : `roster:${bot.threadId}:${bot.updatedAt}`,
        type: failed
          ? ("run.failed" as const)
          : waiting
            ? ("run.waiting_input" as const)
            : ("thread.message.created" as const),
        threadId: bot.threadId,
        botId: bot.id,
        payload: replied ? { role: "bot", blocks: [{ kind: "text", text: bot.preview }] } : {},
      };
      const pending = {
        event,
        botId: bot.id,
        botName: bot.name,
        groupNotification: false,
        allowForeground: interrupted,
      };
      if (!deliverBrowserNotification(pending))
        pendingBrowserNotifications.current.set(bot.threadId, pending);
    }
  }, [bots, openBotId, spaceId, deliverBrowserNotification]);
  const flushPendingBrowserNotifications = useCallback(() => {
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
      enabled: boolean,
      groupNotification: boolean,
      groupId?: string,
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
      });
      if (!eligible || !enabled) return;
      const pending = {
        event,
        botId,
        botName,
        groupNotification,
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
