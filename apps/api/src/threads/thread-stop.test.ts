import { describe, expect, it } from "vitest";
import { isStopMessage } from "./thread-stop.js";

describe("isStopMessage", () => {
  it("delegates text to the stop command parser and rejects attachments or empty input", () => {
    expect(isStopMessage({ text: "stop" })).toBe(true);
    expect(isStopMessage({ text: "/cancel" })).toBe(true);
    expect(isStopMessage({ text: "cancel it" })).toBe(false);
    expect(isStopMessage({ text: "stop", artifactIds: ["artifact-1"] })).toBe(false);
    expect(isStopMessage({})).toBe(false);
  });
});
