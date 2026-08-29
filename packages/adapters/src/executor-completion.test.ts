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

  it("uses a contextual fallback for a non-silent peer result", () => {
    expect(
      completionMessageSegments([], { emptyResponseText: "Update from Researcher: 42" }),
    ).toEqual([{ kind: "text", text: "Update from Researcher: 42" }]);
  });

  it("keeps a peer result visible when the runtime emitted only tool activity", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Read file", count: 1 }] }];
    expect(
      completionMessageSegments(steps, { emptyResponseText: "Update from Researcher: 42" }),
    ).toEqual([...steps, { kind: "text", text: "Update from Researcher: 42" }]);
  });

  it("does not append fallback text to a tool-only FYI", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Read file", count: 1 }] }];
    expect(
      completionMessageSegments(steps, {
        allowSilentEmpty: true,
        emptyResponseText: "synthetic text",
      }),
    ).toEqual(steps);
  });

  it("normalizes a blank fallback", () => {
    expect(completionMessageSegments([], { emptyResponseText: "   " })).toEqual([
      { kind: "text", text: "done." },
    ]);
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
