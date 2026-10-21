import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const screen = (name: string) => readFileSync(new URL(`../app/${name}`, import.meta.url), "utf8");
const scrollViewProps = (source: string) => {
  const start = source.indexOf("<ScrollView");
  return source.slice(start, source.indexOf(">", start));
};

describe("form keyboard handling", () => {
  // The keyboard covered the primary button at the end of these forms, and the form could not
  // scroll it clear, so it could only be reached after dismissing the keyboard.
  it("New group keeps Create group on top of the keyboard", () => {
    const source = screen("new-group.tsx");
    const label = 'label={pending ? t("Creating…") : t("Create group")}';
    const avoidingView = source.slice(source.indexOf("<KeyboardAvoidingView"));
    expect(avoidingView).toContain('behavior="padding"');
    // The button sits below the scroll view, not at the end of its content.
    expect(source.indexOf(label)).toBeGreaterThan(source.indexOf("</ScrollView>"));
    expect(scrollViewProps(source)).toContain('keyboardShouldPersistTaps="handled"');
  });

  it.each(["group-settings.tsx", "bot-settings.tsx", "new.tsx"])(
    "%s lets its form scroll clear of the keyboard",
    (name) => {
      const props = scrollViewProps(screen(name));
      expect(props).toContain("automaticallyAdjustKeyboardInsets");
      expect(props).toContain('keyboardShouldPersistTaps="handled"');
    },
  );
});
