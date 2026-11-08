// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  scheduleTranscriptSnapToEnd,
  stillStickAfterRefresh,
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
    const transcript = { scrollTop: 950 };
    expect(transcriptCanSnapAfterFrame(transcript, transcript, 950)).toBe(true);
    transcript.scrollTop = 920;
    expect(transcriptCanSnapAfterFrame(transcript, transcript, 950)).toBe(false);
  });

  it("does not snap a replacement transcript", () => {
    const queuedTranscript = { scrollTop: 950 };
    const replacementTranscript = { scrollTop: 950 };
    expect(transcriptCanSnapAfterFrame(replacementTranscript, queuedTranscript, 950)).toBe(false);
  });
});

describe("stillStickAfterRefresh", () => {
  const nearEnd = { scrollHeight: 1_000, scrollTop: 950, clientHeight: 500 };
  const scrolledUp = { scrollHeight: 1_000, scrollTop: 120, clientHeight: 500 };

  it("prefers the current scroller when present", () => {
    expect(stillStickAfterRefresh(true, nearEnd, scrolledUp)).toBe(false);
    expect(stillStickAfterRefresh(true, scrolledUp, nearEnd)).toBe(true);
  });

  it("falls back to the previous scroller only while the current one is missing", () => {
    expect(stillStickAfterRefresh(true, nearEnd, null)).toBe(true);
    expect(stillStickAfterRefresh(true, scrolledUp, null)).toBe(false);
    expect(stillStickAfterRefresh(true, null, null)).toBe(true);
  });

  it("never sticks when follow mode was already off", () => {
    expect(stillStickAfterRefresh(false, nearEnd, nearEnd)).toBe(false);
  });
});

describe("scheduleTranscriptSnapToEnd", () => {
  it("snaps the live scroller after layout even when the DOM node was replaced", async () => {
    const queued = { scrollTop: 950, scrollHeight: 1_000, clientHeight: 500 };
    // Replacement must still be near the end; a remount mid-history must not yank.
    const replacement = { scrollTop: 1_520, scrollHeight: 1_600, clientHeight: 500 };
    let current: typeof queued | typeof replacement = queued;
    scheduleTranscriptSnapToEnd(() => current, true);
    current = replacement;
    await new Promise((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(null))),
    );
    expect(replacement.scrollTop).toBe(1_600);
  });

  it("does not snap when the reader scrolled up during the wait", async () => {
    const scroller = { scrollTop: 400, scrollHeight: 2_000, clientHeight: 500 };
    scheduleTranscriptSnapToEnd(() => scroller, true);
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    scroller.scrollTop = 120;
    await new Promise((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(null))),
    );
    expect(scroller.scrollTop).toBe(120);
  });

  it("does not snap a same scroller that moved up a little while still near the end", async () => {
    const scroller = { scrollTop: 950, scrollHeight: 1_000, clientHeight: 500 };
    scheduleTranscriptSnapToEnd(() => scroller, true);
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    scroller.scrollTop = 940;
    await new Promise((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(null))),
    );
    expect(scroller.scrollTop).toBe(940);
  });
});

describe("transcriptMovedDown", () => {
  it("does not treat an uninitialized baseline as downward movement", () => {
    expect(transcriptMovedDown(null, 920)).toBe(false);
    expect(transcriptMovedDown(950, 920)).toBe(false);
    expect(transcriptMovedDown(920, 950)).toBe(true);
  });
});
