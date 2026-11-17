import { describe, expect, it } from "vitest";
import type { ToolQuestionField } from "./tool-question.js";
import {
  checkToolQuestionValues,
  toolQuestionInitialDraft,
  toolQuestionSentValues,
  toolQuestionShownStatus,
} from "./tool-question.js";

const fields: ToolQuestionField[] = [
  { name: "count", label: "Count", required: true, type: "number", integer: false, default: 2 },
  { name: "at", label: "At", required: false, type: "text", format: "date-time", maxLength: 100 },
  { name: "__proto__", label: "Odd", required: true, type: "text", maxLength: 10 },
];

describe("tool question forms", () => {
  it("keeps numbers as typed until sent, then parses them", () => {
    expect(toolQuestionInitialDraft(fields)).toEqual({
      count: "2",
      at: undefined,
      __proto__: undefined,
    });
    const sent = toolQuestionSentValues(fields, { count: "1.5", at: "", __proto__: "x" });
    expect(sent.count).toBe(1.5);
    expect(toolQuestionSentValues(fields, { count: "1." }).count).toBe(1);
    // Text that is no number goes as typed, so the server names the field.
    expect(toolQuestionSentValues(fields, { count: "-" }).count).toBe("-");
  });

  it("sends a date-time with seconds and an offset", () => {
    const at = toolQuestionSentValues(fields, { at: "2026-11-18T09:30" }).at as string;
    expect(at).toMatch(/^2026-11-1[78]T\d{2}:30:00\.000Z$/);
  });

  it("keeps a field named like an object internal", () => {
    const checked = checkToolQuestionValues(fields, JSON.parse('{"count":1,"__proto__":"x"}'));
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(Object.hasOwn(checked.values, "__proto__")).toBe(true);
  });

  it("reads a field named like an object built-in as empty when it was left out", () => {
    const optional: ToolQuestionField[] = [
      { name: "toString", label: "Note", required: false, type: "text", maxLength: 10 },
    ];
    expect(checkToolQuestionValues(optional, {})).toEqual({ ok: true, values: {} });
  });

  it("shows the answer just sent until the card itself changes", () => {
    expect(toolQuestionShownStatus("pending", "accept")).toBe("accepted");
    expect(toolQuestionShownStatus("pending", undefined)).toBe("pending");
    expect(toolQuestionShownStatus("expired", "accept")).toBe("expired");
  });
});
