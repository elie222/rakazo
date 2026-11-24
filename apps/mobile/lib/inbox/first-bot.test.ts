import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askFirstBot, forgetFirstBotRequests, needsFirstBot } from "./first-bot";

afterEach(() => forgetFirstBotRequests());

const navigation = (
  options: { bots?: number; groups?: number; spaces?: boolean[] } = {},
): Parameters<typeof needsFirstBot>[0] => ({
  current: {
    id: "space-1",
    bots: Array.from({ length: options.bots ?? 0 }),
    groups: Array.from({ length: options.groups ?? 0 }),
  },
  spaces: (options.spaces ?? [false]).map((hasContent) => ({ hasContent })),
});

describe("needsFirstBot", () => {
  it("asks only for an account whose Spaces never held a chat", () => {
    expect(needsFirstBot(navigation())).toBe(true);
    expect(needsFirstBot(navigation({ bots: 1, spaces: [true] }))).toBe(false);
    expect(needsFirstBot(navigation({ groups: 1, spaces: [true] }))).toBe(false);
  });

  it("leaves an emptied account and a new empty Space beside used ones alone", () => {
    // The server marks a Space whose bots were deleted as having content.
    expect(needsFirstBot(navigation({ spaces: [true] }))).toBe(false);
    expect(needsFirstBot(navigation({ spaces: [false, true] }))).toBe(false);
  });

  it("does not ask when the server says no first bot is due", () => {
    expect(needsFirstBot({ ...navigation(), firstBotDue: false })).toBe(false);
    expect(needsFirstBot({ ...navigation(), firstBotDue: true })).toBe(true);
  });

  it("does not ask before the Spaces are known", () => {
    expect(needsFirstBot(navigation({ spaces: [] }))).toBe(false);
  });
});

describe("askFirstBot", () => {
  it("asks once per Space, and a load meanwhile joins the asking", async () => {
    const answer = deferred<{ botId: string | null }>();
    const request = vi.fn(() => answer.promise);
    const first = askFirstBot("space-1", request);
    const second = askFirstBot("space-1", request);
    answer.resolve({ botId: "chief" });
    await expect(first).resolves.toBe("chief");
    await expect(second).resolves.toBe("chief");
    await expect(askFirstBot("space-1", request)).resolves.toBe("chief");
    expect(request).toHaveBeenCalledOnce();
  });

  it("asks again after a failure that may pass, not after a refusal", async () => {
    const offline = new TypeError("Network request failed");
    const request = vi
      .fn<() => Promise<{ botId: string | null }>>()
      .mockRejectedValueOnce(offline)
      .mockResolvedValueOnce({ botId: null });
    await expect(askFirstBot("space-1", request)).resolves.toBeNull();
    await expect(askFirstBot("space-1", request)).resolves.toBeNull();
    await expect(askFirstBot("space-1", request)).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
