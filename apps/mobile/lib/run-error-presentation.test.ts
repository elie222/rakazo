import { describe, expect, it } from "vitest";
import { parseRunDiagnostic } from "./run-error-presentation";

describe("readable provider diagnostics", () => {
  it.each(["", "403: "])("parses JSON with prefix %s", (prefix) => {
    const result = parseRunDiagnostic(
      `${prefix}{"status":403,"error":{"message":"Weekly key limit exceeded","metadata":{"reset_at":"2026-10-21T00:00:00Z"}}}`,
      "en",
      Date.parse("2026-10-20T00:00:00Z"),
    );
    expect(result).toMatchObject({
      status: "403",
      message: "Weekly key limit exceeded",
      limit: "weekly",
    });
    expect(result.resets).toContain("2026");
    expect(Object.values(result).join(" ")).not.toMatch(/[{}"]/);
  });
  it.each([
    '403: {"message": "Broken diagnostic',
    'Plain "quoted" message {without JSON}',
    '["invalid envelope"]',
  ])("strips JSON punctuation from malformed or unsupported input: %s", (raw) => {
    expect(parseRunDiagnostic(raw, "en").message).not.toMatch(/[{}[\]"]/);
  });
  it.each(["not-a-date", "2026-02-30", "2026-04-31T00:00:00Z"])(
    "omits invalid reset %s",
    (reset) => {
      expect(
        parseRunDiagnostic(
          JSON.stringify({ message: "weekly limit", metadata: { reset_at: reset } }),
          "en",
        ).resets,
      ).toBeUndefined();
    },
  );
  it("does not render JSON punctuation embedded in a provider message", () => {
    expect(
      parseRunDiagnostic(
        JSON.stringify({ message: 'The {weekly} limit for "key" was reached' }),
        "en",
      ).message,
    ).toBe("The weekly limit for key was reached");
  });
});

it.each(["2026-10-19T00:00:00Z", "2026-10-20T00:00:00Z"])(
  "omits past or current reset %s",
  (reset) => {
    expect(
      parseRunDiagnostic(
        JSON.stringify({ message: "weekly limit", metadata: { reset_at: reset } }),
        "en",
        Date.parse("2026-10-20T00:00:00Z"),
      ).resets,
    ).toBeUndefined();
  },
);
