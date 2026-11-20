import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInterimBargeIn,
  INTERIM_BARGE_IN_MS,
  isCallBargeIn,
  isInterimCallBargeIn,
} from "./barge-in.js";
import { spokenMemory } from "./echo.js";

const SPOKEN = "I'm here and hearing you";

describe("call barge-in", () => {
  afterEach(() => {
    spokenMemory.clear();
  });

  it.each(["stop", "Stop!", "WAIT", "hold on", "Hold on.", "pause", "no"])(
    "lets the interruption %j cut a reply short",
    (text) => {
      expect(isCallBargeIn(text)).toBe(true);
    },
  );

  it("lets a sentence cut a reply short", () => {
    expect(isCallBargeIn("wait, what about the deploy")).toBe(true);
    expect(isInterimCallBargeIn("what about the deploy")).toBe(true);
  });

  it("keeps playing through a one-word backchannel", () => {
    expect(isCallBargeIn("yeah")).toBe(false);
    expect(isInterimCallBargeIn("yeah")).toBe(false);
    expect(isInterimCallBargeIn("stop")).toBe(false);
  });

  it.each(["等一下我想问另一个问题", "ちょっと質問があるんですけど", "ขอถามอีกเรื่องหนึ่งได้ไหม"])(
    "lets the unspaced sentence %j cut a reply short",
    (text) => {
      expect(isCallBargeIn(text)).toBe(true);
      expect(isInterimCallBargeIn(text)).toBe(true);
    },
  );

  it.each(["等一下", "停", "หยุด", "不是", "いいえ", "ไม่"])(
    "lets the unspaced interruption %j cut a reply short",
    (text) => {
      expect(isCallBargeIn(text)).toBe(true);
    },
  );

  it.each(["嗯", "好的", "对", "はい", "うん", "そうですね", "ครับ", "谢谢"])(
    "keeps playing through the unspaced backchannel %j",
    (text) => {
      expect(isCallBargeIn(text)).toBe(false);
      expect(isInterimCallBargeIn(text)).toBe(false);
    },
  );

  it("keeps playing through English backchannels", () => {
    for (const text of ["okay", "uh", "mm", "yeah"]) expect(isCallBargeIn(text)).toBe(false);
  });

  it("still tells sentences from backchannels without Intl.Segmenter", () => {
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    try {
      expect(isCallBargeIn("等一下我想问另一个问题")).toBe(true);
      expect(isCallBargeIn("ขอถามอีกเรื่องหนึ่งได้ไหม")).toBe(true);
      expect(isCallBargeIn("好的")).toBe(false);
      expect(isCallBargeIn("谢谢")).toBe(false);
      expect(isCallBargeIn("wait, what about the deploy")).toBe(true);
      expect(isCallBargeIn("yeah")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores the reply leaking back at the playback threshold", () => {
    spokenMemory.remember(SPOKEN);
    expect(isCallBargeIn("I am here what about that")).toBe(false);
    expect(isInterimCallBargeIn("I am here and hearing")).toBe(false);
  });

  it("ignores an unspaced reply leaking back", () => {
    spokenMemory.remember("我在这里可以听到你说话");
    expect(isCallBargeIn("我在这里可以听到你")).toBe(false);
  });

  it("ignores an empty transcript", () => {
    expect(isCallBargeIn("   ")).toBe(false);
    expect(isInterimCallBargeIn("")).toBe(false);
  });
});

describe("interim barge-in countdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cuts in once a phrase stands long enough, and only once", () => {
    vi.useFakeTimers();
    const onBargeIn = vi.fn();
    const interim = createInterimBargeIn(onBargeIn);
    interim.hear("what about");
    vi.advanceTimersByTime(INTERIM_BARGE_IN_MS - 1);
    // A revision that still qualifies keeps the running countdown.
    interim.hear("what about the deploy");
    expect(onBargeIn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onBargeIn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INTERIM_BARGE_IN_MS);
    expect(onBargeIn).toHaveBeenCalledTimes(1);
  });

  it("resets when the phrase stops qualifying or is cleared", () => {
    vi.useFakeTimers();
    const onBargeIn = vi.fn();
    const interim = createInterimBargeIn(onBargeIn);
    interim.hear("what about");
    interim.hear("yeah");
    vi.advanceTimersByTime(INTERIM_BARGE_IN_MS);
    interim.hear("what about");
    interim.clear();
    vi.advanceTimersByTime(INTERIM_BARGE_IN_MS);
    expect(onBargeIn).not.toHaveBeenCalled();
  });
});
