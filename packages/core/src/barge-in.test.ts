import { afterEach, describe, expect, it } from "vitest";
import { isCallBargeIn, isInterimCallBargeIn } from "./barge-in.js";
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

  it("ignores the reply leaking back at the playback threshold", () => {
    spokenMemory.remember(SPOKEN);
    expect(isCallBargeIn("I am here what about that")).toBe(false);
    expect(isInterimCallBargeIn("I am here and hearing")).toBe(false);
  });

  it("ignores an empty transcript", () => {
    expect(isCallBargeIn("   ")).toBe(false);
    expect(isInterimCallBargeIn("")).toBe(false);
  });
});
