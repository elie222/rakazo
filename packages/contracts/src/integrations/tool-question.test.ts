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
    expect(toolQuestionSentValues(fields, { count: "1,5" }).count).toBe(1.5);
    // Text that is no number goes as typed, so the server names the field.
    expect(toolQuestionSentValues(fields, { count: "-" }).count).toBe("-");
  });

  it("sends a date-time with seconds and an offset", () => {
    const at = toolQuestionSentValues(fields, { at: "2026-11-18T09:30" }).at as string;
    // The same instant, whatever this machine's offset.
    expect(at).toBe(new Date(2026, 10, 18, 9, 30).toISOString());
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

  it("checks a text field's declared format", () => {
    const formatted = (format: "email" | "uri" | "date" | "date-time"): ToolQuestionField[] => [
      { name: "v", label: "V", required: true, type: "text", format, maxLength: 100 },
    ];
    const ok = (format: Parameters<typeof formatted>[0], v: string) =>
      checkToolQuestionValues(formatted(format), { v }).ok;
    expect([ok("email", "sam@example.test"), ok("email", "sam")]).toEqual([true, false]);
    expect([ok("uri", "https://example.test/a"), ok("uri", "not a url")]).toEqual([true, false]);
    expect([ok("date", "2026-11-18"), ok("date", "2026-02-30"), ok("date", "2024-99-01")]).toEqual([
      true,
      false,
      false,
    ]);
    expect([
      ok("date-time", "2026-11-18T09:30:00.000Z"),
      ok("date-time", "2024-02-30T12:00:00Z"),
    ]).toEqual([true, false]);
  });

  it("starts an optional yes/no or choice the server gave no default unset", () => {
    const optional: ToolQuestionField[] = [
      { name: "ok", label: "OK", required: false, type: "boolean" },
      {
        name: "pick",
        label: "Pick",
        required: false,
        type: "choice",
        options: [{ value: "a", label: "A" }],
      },
      { name: "must", label: "Must", required: true, type: "boolean" },
    ];
    expect(toolQuestionInitialDraft(optional)).toEqual({
      ok: undefined,
      pick: undefined,
      must: false,
    });
  });

  it("shows the answer just sent until the card itself changes", () => {
    expect(toolQuestionShownStatus("pending", "accept")).toBe("accepted");
    expect(toolQuestionShownStatus("pending", undefined)).toBe("pending");
    expect(toolQuestionShownStatus("expired", "accept")).toBe("expired");
  });
});
