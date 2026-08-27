import { describe, expect, it } from "vitest";
import {
  transcriptCanSnapAfterFrame,
  transcriptIsNearEnd,
  transcriptMovedDown,
} from "./transcript-scroll.js";

describe("transcriptIsNearEnd", () => {
  it("follows only while the viewport is within 80px of the latest message", () => {
    expect(transcriptIsNearEnd({ scrollHeight: 1_000, scrollTop: 421, clientHeight: 500 })).toBe(
      true,
    );
    expect(transcriptIsNearEnd({ scrollHeight: 1_000, scrollTop: 420, clientHeight: 500 })).toBe(
      false,
    );
  });
});

describe("transcriptCanSnapAfterFrame", () => {
  it("does not snap after the reader moves while the frame is queued", () => {
    expect(transcriptCanSnapAfterFrame({ scrollTop: 920 }, 950)).toBe(false);
    expect(transcriptCanSnapAfterFrame({ scrollTop: 950 }, 950)).toBe(true);
  });
});

describe("transcriptMovedDown", () => {
  it("does not treat an uninitialized baseline as downward movement", () => {
    expect(transcriptMovedDown(null, 920)).toBe(false);
    expect(transcriptMovedDown(950, 920)).toBe(false);
    expect(transcriptMovedDown(920, 950)).toBe(true);
  });
});
