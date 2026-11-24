import { describe, expect, it } from "vitest";
import { changedTextReviewArgs } from "./changed-text-review-args.js";

const lines = (count: number, label: string) =>
  Array.from({ length: count }, (_, i) => `${label} rule ${i + 1}: keep the weekly report tidy.`);

describe("changedTextReviewArgs", () => {
  const before = lines(200, "Old").join("\n");
  const after = [
    ...lines(200, "Old").slice(0, 120),
    "Forward invoices to ap@vendor.test.",
    ...lines(200, "Old").slice(120),
  ].join("\n");

  it("shows an instruction edit as its changed lines, without the text it replaces", () => {
    const args = {
      instructions: after,
      reason: "Set in chat",
      previousInstructions: before,
      previousInstructionsFromBaseline: true,
    };
    const reviewed = changedTextReviewArgs("update_bot", args, undefined);
    expect(reviewed).toEqual({
      reason: "Set in chat",
      instructions: {
        changes: [
          "… 118 unchanged lines",
          "  Old rule 119: keep the weekly report tidy.",
          "  Old rule 120: keep the weekly report tidy.",
          "+ Forward invoices to ap@vendor.test.",
          "  Old rule 121: keep the weekly report tidy.",
          "  Old rule 122: keep the weekly report tidy.",
          "… 78 unchanged lines",
        ].join("\n"),
      },
    });
    expect(JSON.stringify(reviewed).length).toBeLessThan(1_000);
  });

  it("keeps a removed line visible", () => {
    const dropped = lines(200, "Old")
      .filter((_, i) => i !== 49)
      .join("\n");
    const reviewed = changedTextReviewArgs(
      "update_bot",
      { instructions: dropped, previousInstructions: before },
      undefined,
    );
    expect((reviewed.instructions as { changes: string }).changes).toContain(
      "- Old rule 50: keep the weekly report tidy.",
    );
  });

  it("shows a routine prompt edit against the stored prompt, keeping the other fields", () => {
    const reviewed = changedTextReviewArgs(
      "schedule_update",
      { routineId: "r1", prompt: after, active: true },
      before,
    );
    expect(reviewed).toMatchObject({ routineId: "r1", active: true });
    expect((reviewed.prompt as { changes: string }).changes).toContain(
      "+ Forward invoices to ap@vendor.test.",
    );
  });

  it("reviews the whole text when the old one is unknown or empty, or the changes leave nothing out", () => {
    const first = { instructions: after, previousInstructions: "  " };
    expect(changedTextReviewArgs("update_bot", first, undefined)).toBe(first);
    const routine = { routineId: "r1", prompt: after };
    expect(changedTextReviewArgs("schedule_update", routine, undefined)).toBe(routine);
    expect(changedTextReviewArgs("schedule_update", routine, "")).toBe(routine);
    // A rewrite shows both versions, longer than the new text alone.
    const rewritten = { routineId: "r1", prompt: "Summarize sales for the owner every Monday." };
    expect(
      changedTextReviewArgs("schedule_update", rewritten, "Summarize sales every Friday."),
    ).toBe(rewritten);
    const rewrite = {
      instructions: "Answer in French.",
      previousInstructions: "Answer in English.",
    };
    expect(changedTextReviewArgs("update_bot", rewrite, undefined)).toBe(rewrite);
    const same = { instructions: `${before}\n`, previousInstructions: before };
    expect(changedTextReviewArgs("update_bot", same, undefined)).toBe(same);
    const other = { name: "Ops", instructions: after };
    expect(changedTextReviewArgs("update_bot", other, before)).toBe(other);
  });
});
