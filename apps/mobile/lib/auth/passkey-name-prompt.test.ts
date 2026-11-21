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

  it("allows up to 100 characters", () => {
    const prompt = open();
    prompt.submit(`  ${"a".repeat(100)} `);
    expect(prompt.onSubmit.mock.calls).toEqual([["a".repeat(100)]]);
  });

  it("prefills and ignores unchanged name", () => {
    const prompt = open("Work");
    expect(prompt.value).toBe("Work");
    prompt.submit(" Work ");
    prompt.submit("Home");
    expect(prompt.onSubmit.mock.calls).toEqual([["Home"]]);
  });
});
