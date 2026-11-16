import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  allowFocusPrompt,
  cancelFocusPrompt,
  FOCUS_PROMPT_DELAY_MS,
  scheduleFocusPrompt,
} from "./focus-prompt";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  cancelFocusPrompt();
});

afterEach(() => {
  cancelFocusPrompt();
  vi.useRealTimers();
});

it.each([true, false])(
  "sends the focus card through the creation's save (immediate: %s)",
  async (immediate) => {
    const send = vi.fn().mockResolvedValue({});
    allowFocusPrompt("bot-new");
    scheduleFocusPrompt("bot-new", immediate, send);
    if (!immediate) {
      expect(send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(FOCUS_PROMPT_DELAY_MS);
    }
    expect(send).toHaveBeenCalledExactlyOnceWith("onboarding/promptFocus", { botId: "bot-new" });
  },
);
