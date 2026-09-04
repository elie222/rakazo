import { rpc } from "./api";

/** Delay before the setup focus card for a non-first bot. */
export const FOCUS_PROMPT_DELAY_MS = 10_000;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingBotId: string | null = null;
/** Bot ids whose delayed prompt must not run after the user left the thread. */
const cancelledBotIds = new Set<string>();

/** Allow a freshly created bot to schedule a focus prompt after navigation. */
export function allowFocusPrompt(botId: string): void {
  cancelledBotIds.delete(botId);
}

/** Cancel a scheduled focus prompt. Pass botId to cancel only that bot. */
export function cancelFocusPrompt(botId?: string): void {
  if (botId) cancelledBotIds.add(botId);
  if (botId && pendingBotId && pendingBotId !== botId) return;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
  pendingBotId = null;
}

/**
 * Schedule posting the focus choice card. Survives leaving the home screen so
 * navigating into the new bot's thread does not cancel the delay. Call
 * `allowFocusPrompt` before navigating, and `cancelFocusPrompt` when leaving
 * that bot's thread (unmount / bot switch — not blur onto settings) so a late
 * `onboarding/start` cannot schedule after departure.
 */
export function scheduleFocusPrompt(botId: string, immediate: boolean): void {
  if (cancelledBotIds.has(botId)) return;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
  pendingBotId = null;
  if (immediate) {
    void rpc("onboarding/promptFocus", { botId }).catch(() => undefined);
    return;
  }
  pendingBotId = botId;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    pendingBotId = null;
    if (cancelledBotIds.has(botId)) return;
    void rpc("onboarding/promptFocus", { botId }).catch(() => undefined);
  }, FOCUS_PROMPT_DELAY_MS);
}
