import { Alert, Platform } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { promptAccountDeletion } from "./delete-account-prompt";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Alert: { prompt: vi.fn() },
}));

const input = {
  title: "Delete your account?",
  message: "This permanently deletes your account.",
  cancelLabel: "Cancel",
  deleteLabel: "Delete",
  onSubmit: vi.fn(),
};

describe("account deletion prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Platform.OS = "ios";
  });

  it("asks for a secure password on iOS and deletes only when one is entered", () => {
    expect(promptAccountDeletion(input)).toBe(true);
    expect(Alert.prompt).toHaveBeenCalledOnce();
    const [title, message, buttons, type] = vi.mocked(Alert.prompt).mock.calls[0]!;
    if (!Array.isArray(buttons)) throw new Error("expected alert buttons");
    expect(title).toBe("Delete your account?");
    expect(message).toBe("This permanently deletes your account.");
    expect(type).toBe("secure-text");
    expect(buttons.map((button) => [button.text, button.style])).toEqual([
      ["Cancel", "cancel"],
      ["Delete", "destructive"],
    ]);

    const press = (index: number, value?: string) => {
      const onPress = buttons[index]?.onPress as ((text?: string) => void) | undefined;
      onPress?.(value);
    };
    press(1, "");
    press(1, undefined);
    expect(input.onSubmit).not.toHaveBeenCalled();
    press(1, "secret-password");
    expect(input.onSubmit).toHaveBeenCalledExactlyOnceWith("secret-password");
    press(0);
    expect(input.onSubmit).toHaveBeenCalledOnce();
  });

  it("leaves Android to the screen dialog because Alert.prompt is iOS-only", () => {
    Platform.OS = "android";
    expect(promptAccountDeletion(input)).toBe(false);
    expect(Alert.prompt).not.toHaveBeenCalled();
  });
});
