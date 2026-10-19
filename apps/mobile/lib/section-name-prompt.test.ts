import { Alert } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { promptSectionName } from "./section-name-prompt";

vi.mock("react-native", () => ({ Alert: { prompt: vi.fn() } }));

describe("section name prompt", () => {
  beforeEach(() => vi.clearAllMocks());

  function open(defaultValue?: string) {
    const onSubmit = vi.fn();
    promptSectionName({
      title: defaultValue ? "Rename section" : "New section",
      cancelLabel: "Cancel",
      submitLabel: defaultValue ? "Save" : "Create",
      defaultValue,
      onSubmit,
    });
    const [title, message, buttons, type, value] = vi.mocked(Alert.prompt).mock.calls.at(-1)!;
    if (!Array.isArray(buttons)) throw new Error("expected alert buttons");
    const submit = (text?: string) => (buttons[1]!.onPress as (text?: string) => void)(text);
    return { title, message, buttons, type, value, submit, onSubmit };
  }

  it("asks for a new section name with the system prompt", () => {
    const prompt = open();
    expect([prompt.title, prompt.message, prompt.type, prompt.value]).toEqual([
      "New section",
      undefined,
      "plain-text",
      undefined,
    ]);
    expect(prompt.buttons.map((button) => [button.text, button.style])).toEqual([
      ["Cancel", "cancel"],
      ["Create", undefined],
    ]);
    prompt.submit("  ");
    prompt.submit(undefined);
    prompt.submit(`  ${"a".repeat(70)} `);
    expect(prompt.onSubmit.mock.calls).toEqual([["a".repeat(60)]]);
  });

  it("prefills a rename and ignores an unchanged name", () => {
    const prompt = open("Work");
    expect(prompt.value).toBe("Work");
    prompt.submit(" Work ");
    prompt.submit("Home");
    expect(prompt.onSubmit.mock.calls).toEqual([["Home"]]);
  });
});
