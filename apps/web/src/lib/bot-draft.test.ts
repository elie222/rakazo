import { describe, expect, it } from "vitest";
import { BOT_FIELD_LIMITS, validateBotDraft } from "./bot-draft";

const validDraft = {
  name: "Operator",
  title: "Runs bounded tasks",
  description: "A beta operational agent.",
  instructions: "Use least privilege.",
};

describe("validateBotDraft", () => {
  it("accepts a valid onboarding bot draft", () => {
    expect(validateBotDraft(validDraft)).toBeNull();
  });

  it("rejects blank and over-limit fields before the RPC call", () => {
    expect(validateBotDraft({ ...validDraft, name: "  " })).toMatch(/name/i);

    const cases = [
      ["name", BOT_FIELD_LIMITS.name, /name/i],
      ["title", BOT_FIELD_LIMITS.title, /title/i],
      ["description", BOT_FIELD_LIMITS.description, /description/i],
      ["instructions", BOT_FIELD_LIMITS.instructions, /instructions/i],
    ] as const;

    for (const [field, limit, message] of cases) {
      expect(validateBotDraft({ ...validDraft, [field]: "x".repeat(limit + 1) })).toMatch(message);
    }
  });
});
