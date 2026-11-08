// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  scheduleTranscriptSnapToEnd,
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

describe("scheduleTranscriptSnapToEnd", () => {
  it("snaps the live scroller after layout even when the DOM node was replaced", async () => {
    const queued = { scrollTop: 950, scrollHeight: 1_000, clientHeight: 500 };
    const replacement = { scrollTop: 950, scrollHeight: 1_600, clientHeight: 500 };
    let current: typeof queued = queued;
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
});

describe("transcriptMovedDown", () => {
  it("does not treat an uninitialized baseline as downward movement", () => {
    expect(transcriptMovedDown(null, 920)).toBe(false);
    expect(transcriptMovedDown(950, 920)).toBe(false);
    expect(transcriptMovedDown(920, 950)).toBe(true);
  });
});
