import { isRunWaitingOnUser, isRunWorking } from "./run-state.js";

export type NotificationAttention = "needs_attention" | "working" | "unread";

/** A question wins over work, and unread is a receipt, not another running state. */
export function notificationAttention(
  status: string,
  unread = false,
  failed = false,
): NotificationAttention | null {
  if (isRunWaitingOnUser(status)) return "needs_attention";
  if (isRunWorking(status)) return "working";
  if ((status === "failed" || failed) && unread) return "needs_attention";
  return unread ? "unread" : null;
}
