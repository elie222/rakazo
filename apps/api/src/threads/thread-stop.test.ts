import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { describe, expect, it } from "vitest";
import { isStopMessage } from "./thread-stop.js";

describe("isStopMessage", () => {
  it("recognizes bare stop and cancel commands across languages", () => {
    for (const text of [
      "stop",
      "stop it",
      "stop, please",
      "please, stop",
      "cancel all",
      "/stop",
      "/cancel",
      "/abort",
      "zatrzymaj to",
      "przestan",
      "anuluj",
      "przerwij to",
      "abbrechen",
      "annuler",
      "キャンセル",
      "取消",
    ]) {
      expect(isStopMessage({ text }), text).toBe(true);
    }
  });

  it("ignores normal sentences, negations, and messages with attachments", () => {
    for (const text of [
      "para",
      "¿Para?",
      "stopper",
      "don't stop",
      "do not cancel",
      "stop by the store",
      "can you stop this timer?",
      "cancel my flight",
      "why did it stop?",
      "nie zatrzymuj",
      "nie przerywaj",
    ]) {
      expect(isStopMessage({ text }), text).toBe(false);
    }
    expect(isStopMessage({ text: "stop", artifactIds: ["artifact-1"] })).toBe(false);
    expect(isStopMessage({})).toBe(false);
  });

  it("stays linear on 200k-character punctuation, commas, and slashes", () => {
    expectLinearTime(() => {
      expect(isStopMessage({ text: `${"!".repeat(200_000)}a` })).toBe(false);
      expect(isStopMessage({ text: `stop${",".repeat(200_000)}now` })).toBe(false);
      expect(isStopMessage({ text: `${"/".repeat(200_000)}stop` })).toBe(false);
    });
  });
});
