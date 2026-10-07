import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screen = readFileSync(resolve(mobileRoot, "app/models.tsx"), "utf8");

function sliceBetween(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("Models settings form", () => {
  it("aligns limit fields with the other inputs and drops the billing line", () => {
    const field = sliceBetween(screen, "function limitField(", "const compatConfig");
    expect(field).toContain("styles.sectionTitle");
    expect(field).toContain("style={styles.keyInput}");
    expect(field).not.toContain("modelRow");
    expect(field).not.toContain("maxImagesInput");
    expect(screen).toContain('limitField(t("Maximum output tokens")');
    expect(screen).toContain('limitField(t("Context limit")');
    expect(screen).toMatch(/limitField\(\s*t\("Maximum images per request"\)/);
    expect(screen).not.toContain("selected.billing");
    expect(screen).not.toContain('t("Stored securely. Never shown here.")');
    expect(screen).not.toContain('t("Connect this provider to use it as your personal model.")');
  });

  it("uses a disclosure row for Advanced instead of an underlined link", () => {
    const row = sliceBetween(screen, "function disclosureRow(", "function limitField(");
    expect(row).toContain("styles.card");
    expect(row).toContain("styles.modelRow");
    expect(row).toContain("styles.chevron");
    expect(row).not.toContain("textDecorationLine");
    expect(row).not.toContain("helpLabel");
    expect(screen).toContain('disclosureRow(t("Advanced")');
    expect(screen).not.toContain("helpLabel");
  });

  it("exposes the shown thinking value on the effort rows", () => {
    const effort = sliceBetween(
      screen,
      'accessibilityLabel={t("Reasoning effort")}',
      't("Supports images")',
    );
    expect(effort).toContain("accessibilityValue={{ text: reasoningEffortValue }}");
    expect(effort).toContain("{reasoningEffortValue}");
    const thinking = sliceBetween(
      screen,
      'accessibilityLabel={t("Thinking")}',
      'disclosureRow(t("Advanced")',
    );
    expect(thinking).toContain("accessibilityValue={{ text: catalogThinkingValue }}");
    expect(thinking).toContain("{catalogThinkingValue}");
  });
});
