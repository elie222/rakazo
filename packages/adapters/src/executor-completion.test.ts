import { describe, expect, it } from "vitest";
import { completionMessageSegments, completionNotificationBody } from "./executor.js";

describe("completionMessageSegments", () => {
  it("keeps visible tool activity without appending a generic completion claim", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Message bot", count: 1 }] }];
    expect(completionMessageSegments(steps)).toEqual(steps);
  });

  it("keeps the last-resort fallback for a runtime that produced nothing", () => {
    expect(completionMessageSegments([])).toEqual([{ kind: "text", text: "done." }]);
  });

  it("allows a fully empty completion for silent bot-message wakes", () => {
    expect(completionMessageSegments([], { allowSilentEmpty: true })).toEqual([]);
  });
});

describe("completionNotificationBody", () => {
  it("omits a body when only tool or step activity remains", () => {
    const steps = completionMessageSegments([
      { kind: "steps" as const, steps: [{ label: "Message bot", count: 1 }] },
    ]);
    expect(completionNotificationBody("", steps)).toBe("");
  });

  it("uses the empty-run text when that is all the run produced", () => {
    expect(completionNotificationBody("", completionMessageSegments([]))).toBe("done.");
  });
});
