import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screen = readFileSync(resolve(mobileRoot, "app/(settings)/language.tsx"), "utf8");
const account = readFileSync(resolve(mobileRoot, "app/(settings)/account.tsx"), "utf8");

describe("Language settings page", () => {
  it("lists every shipped locale and saves the tapped one", () => {
    expect(screen).toContain("{UI_LOCALES.map((code) => {");
    expect(screen).toContain("onPress={() => applyLocale(code)}");
    expect(screen).toContain("void setUiLocale(code)");
  });

  it("marks the active locale as selected", () => {
    expect(screen).toContain("const selected = code === locale;");
    expect(screen).toContain("accessibilityState={{ selected, disabled: saving }}");
    expect(screen).toContain("trailing={selected ? <Checkmark /> : null}");
  });

  it("opens from the Account language row", () => {
    expect(account).toContain('onPress={() => router.push("/language")}');
  });
});
