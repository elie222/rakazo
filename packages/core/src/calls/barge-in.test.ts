import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInterimBargeIn,
  INTERIM_BARGE_IN_MS,
  isCallBargeIn,
  isInterimCallBargeIn,
} from "./barge-in.js";
import { spokenMemory } from "./echo.js";
import { speechWordCount, speechWords } from "./speech-words.js";

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

  describe("without Intl.Segmenter", () => {
    beforeEach(() => {
      vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("still tells sentences from backchannels", () => {
      expect(isCallBargeIn("等一下我想问另一个问题")).toBe(true);
      expect(isCallBargeIn("ขอถามอีกเรื่องหนึ่งได้ไหม")).toBe(true);
      expect(isCallBargeIn("好的")).toBe(false);
      expect(isCallBargeIn("谢谢")).toBe(false);
      expect(isCallBargeIn("wait, what about the deploy")).toBe(true);
      expect(isCallBargeIn("yeah")).toBe(false);
    });

    it.each(["我在查看GitHub的状态", "我正在核对GitHub2的状态"])(
      "keeps playing when the mixed-script reply %j leaks back",
      (text) => {
        spokenMemory.remember(text);
        expect(isCallBargeIn(text)).toBe(false);
        expect(isInterimCallBargeIn(text)).toBe(false);
      },
    );

    it("lets distinct mixed-script and longer overlapping user turns interrupt", () => {
      spokenMemory.remember("我在查看GitHub的状态");
      for (const text of [
        "等等我想问一下Stripe的费用",
        "我在查看GitHub的状态我还想问你另一个问题",
      ]) {
        expect(isCallBargeIn(text)).toBe(true);
        expect(isInterimCallBargeIn(text)).toBe(true);
      }
      expect(isCallBargeIn("停")).toBe(true);
    });

    it("keeps letters, digits, and their accents together without changing pure Chinese or English", () => {
      const mixed = "我在看2FA和Cafe\u0301";
      expect(speechWords(mixed)).toEqual(["我", "在", "看", "2FA", "和", "Cafe\u0301"]);
      expect(speechWordCount(mixed)).toBe(4);
      expect(speechWords("我在这里")).toEqual(["我", "在", "这", "里"]);
      expect(speechWordCount("我在这里")).toBe(2);
      expect(speechWords("using GitHub2")).toEqual(["using", "GitHub2"]);
    });
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
