import { rpc } from "./api";

/** Delay before the setup focus card for a non-first bot. */
export const FOCUS_PROMPT_DELAY_MS = 10_000;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingBotId: string | null = null;

/** Cancel a scheduled focus prompt. Pass botId to cancel only that bot's timer. */
export function cancelFocusPrompt(botId?: string): void {
  if (botId && pendingBotId && pendingBotId !== botId) return;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
  pendingBotId = null;
}

/**
 * Schedule posting the focus choice card. Survives leaving the home screen so
 * navigating into the new bot's thread does not cancel the delay. Cancel when
 * leaving that bot's thread or starting another create.
 */
export function scheduleFocusPrompt(botId: string, immediate: boolean): void {
  cancelFocusPrompt();
  if (immediate) {
    void rpc("onboarding/promptFocus", { botId }).catch(() => undefined);
    return;
  }
  pendingBotId = botId;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    pendingBotId = null;
    void rpc("onboarding/promptFocus", { botId }).catch(() => undefined);
  }, FOCUS_PROMPT_DELAY_MS);
}
