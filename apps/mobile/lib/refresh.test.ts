import { describe, expect, it } from "vitest";
import { threadRefreshDelayMs } from "./refresh";

describe("thread refresh cadence", () => {
  it("polls a dropped active run quickly and idle chats quietly", () => {
    expect(threadRefreshDelayMs("running")).toBe(750);
    expect(threadRefreshDelayMs("queued", { liveSubscribed: false })).toBe(750);
    expect(threadRefreshDelayMs("leased", { liveSubscribed: false })).toBe(750);
    expect(threadRefreshDelayMs("waiting_input")).toBe(5_000);
    expect(threadRefreshDelayMs(undefined)).toBe(5_000);
  });

  it("keeps the slower full snapshot while live events already cover an active run", () => {
    expect(threadRefreshDelayMs("running", { liveSubscribed: true })).toBe(1_500);
    expect(threadRefreshDelayMs("queued", { liveSubscribed: true })).toBe(1_500);
    expect(threadRefreshDelayMs("leased", { liveSubscribed: true })).toBe(1_500);
    expect(threadRefreshDelayMs("waiting_input", { liveSubscribed: true })).toBe(5_000);
    expect(threadRefreshDelayMs(undefined, { liveSubscribed: true })).toBe(5_000);
  });
});
