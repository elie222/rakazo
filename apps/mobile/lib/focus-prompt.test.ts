import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApiRequestContext } from "./api";
import { rpc } from "./api";
import {
  allowFocusPrompt,
  cancelFocusPrompt,
  FOCUS_PROMPT_DELAY_MS,
  scheduleFocusPrompt,
} from "./focus-prompt";

vi.mock("./api", () => ({ rpc: vi.fn().mockResolvedValue({}) }));

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
  "pins the focus card to the creation context (immediate: %s)",
  async (immediate) => {
    const requestContext: ApiRequestContext = {
      apiBase: "https://api.example.test",
      sessionGeneration: 1,
      headers: { "x-rakazo-space-id": "space-work" },
    };
    allowFocusPrompt("bot-new");
    scheduleFocusPrompt("bot-new", immediate, requestContext);
    if (!immediate) {
      expect(rpc).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(FOCUS_PROMPT_DELAY_MS);
    }
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "onboarding/promptFocus",
      { botId: "bot-new" },
      { requestContext },
    );
  },
);

it("keeps unpinned prompts on the selected space", () => {
  allowFocusPrompt("bot-new");
  scheduleFocusPrompt("bot-new", true);
  expect(rpc).toHaveBeenCalledExactlyOnceWith(
    "onboarding/promptFocus",
    { botId: "bot-new" },
    undefined,
  );
});
