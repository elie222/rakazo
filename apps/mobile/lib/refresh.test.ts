import { describe, expect, it } from "vitest";
import { threadRefreshDelayMs } from "./refresh";

describe("thread refresh cadence", () => {
  it("polls active work quickly and idle chats quietly", () => {
    expect(threadRefreshDelayMs("running")).toBe(1_500);
    expect(threadRefreshDelayMs("waiting_input")).toBe(5_000);
    expect(threadRefreshDelayMs(undefined)).toBe(5_000);
  });
});
