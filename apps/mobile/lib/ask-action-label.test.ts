import { afterEach, describe, expect, it } from "vitest";
import { askActionLabel } from "./ask-action-label";
import { resetI18nForTests, t } from "./i18n";

const fakeT = (message: string, values?: Record<string, string | number>) =>
  message.replace(/\{site\}/g, () => String(values?.site));

describe("askActionLabel", () => {
  afterEach(() => resetI18nForTests());

  it.each([
    ["allow", "created", "Create space"],
    ["deny", "created", "Create space"],
    ["allow", "cancelled", "Cancel"],
    ["deny", "cancelled", "Cancel"],
  ] as const)("prioritizes %s's %s outcome", (id, outcome, expected) => {
    expect(askActionLabel({ id, label: "Server label", outcome }, { approval: true }, fakeT)).toBe(
      expected,
    );
  });

  it.each([
    ["always", "example.test", "Always allow example.test"],
    ["always", undefined, "Always allow this tool"],
    ["always", "", "Always allow this tool"],
    ["allow", undefined, "Allow once"],
    ["deny", undefined, "Deny"],
    ["custom", undefined, "Server label"],
  ])("labels approval action %s with site %s", (id, site, expected) => {
    expect(askActionLabel({ id, label: "Server label" }, { approval: true, site }, fakeT)).toBe(
      expected,
    );
  });

  it.each(["Allow in this space", "Allow for this chat"])(
    "labels the user's-computer allow from %s as covering the space",
    (label) => {
      expect(askActionLabel({ id: "allow", label }, { approval: true }, fakeT)).toBe(
        "Allow in this space",
      );
    },
  );

  it.each(["allow", "always", "deny", "custom"])(
    "preserves the server label for non-approval action %s",
    (id) => {
      for (const outcome of [undefined, "created", "cancelled"] as const) {
        expect(
          askActionLabel(
            { id, label: "Server label", outcome },
            { approval: false, site: "example.test" },
            fakeT,
          ),
        ).toBe("Server label");
      }
    },
  );

  it("uses the real mobile translator with site interpolation", () => {
    resetI18nForTests("de");
    expect(
      askActionLabel(
        { id: "always", label: "Server label" },
        { approval: true, site: "example.test" },
        t,
      ),
    ).toBe("example.test immer erlauben");
  });
});
