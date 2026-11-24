import { Alert } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { promptPasskeyName } from "./passkey-name-prompt";

vi.mock("react-native", () => ({ Alert: { prompt: vi.fn() } }));

describe("passkey name prompt", () => {
  beforeEach(() => vi.clearAllMocks());

  function open(defaultValue?: string) {
    const onSubmit = vi.fn();
    promptPasskeyName({
      title: "Rename",
      cancelLabel: "Cancel",
      submitLabel: "Save",
      defaultValue,
      onSubmit,
    });
    const [title, message, buttons, type, value] = vi.mocked(Alert.prompt).mock.calls.at(-1)!;
    if (!Array.isArray(buttons)) throw new Error("expected alert buttons");
    const submit = (text?: string) => (buttons[1]!.onPress as (text?: string) => void)(text);
    return { title, message, buttons, type, value, submit, onSubmit };
  }

  it.each([61, 80, 100])("saves all %i characters of a new name", (length) => {
    const prompt = open("Old name");
    const name = "a".repeat(length);
    prompt.submit(name);
    expect(prompt.onSubmit.mock.calls).toEqual([[name]]);
  });

  it.each([61, 80, 100])("does not submit an unchanged %i-character name", (length) => {
    const name = "a".repeat(length);
    const prompt = open(name);
    expect(prompt.value).toBe(name);
    prompt.submit(name);
    prompt.submit(` ${name} `);
    expect(prompt.onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the native rename dialog and ignores empty input", () => {
    const prompt = open("Old name");
    expect([prompt.title, prompt.message, prompt.type, prompt.value]).toEqual([
      "Rename",
      undefined,
      "plain-text",
      "Old name",
    ]);
    expect(prompt.buttons.map((button) => [button.text, button.style])).toEqual([
      ["Cancel", "cancel"],
      ["Save", undefined],
    ]);
    prompt.submit(undefined);
    prompt.submit("");
    prompt.submit("   ");
    expect(prompt.onSubmit).not.toHaveBeenCalled();
  });

  it("trims names and limits them to 100 characters", () => {
    const prompt = open();
    prompt.submit("  New name  ");
    prompt.submit(` ${"a".repeat(101)} `);
    expect(prompt.onSubmit.mock.calls).toEqual([["New name"], ["a".repeat(100)]]);
  });
});
