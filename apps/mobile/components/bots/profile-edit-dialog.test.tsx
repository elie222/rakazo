// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTextEditDialog } from "./profile-edit-dialog";

const { platform, prompt } = vi.hoisted(() => ({
  platform: { OS: "ios" },
  prompt: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: platform,
  Alert: { prompt },
  Modal: () => null,
  Pressable: () => null,
  Text: () => null,
  TextInput: () => null,
  View: () => null,
}));
vi.mock("../../lib/native/native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("../native/native-action-button", () => ({ NativeActionButton: () => null }));
vi.mock("../native/native-symbol", () => ({ NativeSymbol: () => null }));

type Buttons = { text: string; onPress?: (value?: string) => void }[];

let ask: (value: string, onCommit: (next: string) => void) => void;
let unmount: () => void;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  platform.OS = "ios";
  prompt.mockReset();
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() {
    ask = useTextEditDialog("Rename", 5).ask;
    return null;
  }
  act(() => root.render(createElement(Probe)));
  unmount = () => act(() => root.unmount());
});

afterEach(() => unmount());

function save(call: number, value: string) {
  const buttons = prompt.mock.calls[call]?.[2] as Buttons;
  act(() => buttons.find((button) => button.text === "Save")?.onPress?.(value));
}

describe("text edit dialog", () => {
  it("re-opens the iOS prompt with the text kept when it is too long", () => {
    const onCommit = vi.fn();
    ask("Old", onCommit);
    save(0, "Too long!");
    expect(onCommit).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1]?.[0]).toBe("Rename");
    expect(prompt.mock.calls[1]?.[1]).toBe("Use 5 characters or fewer");
    expect(prompt.mock.calls[1]?.[4]).toBe("Too long!");
    save(1, "Short");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Short");
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("commits a valid trimmed value once", () => {
    const onCommit = vi.fn();
    ask("Old", onCommit);
    expect(prompt.mock.calls[0]?.[1]).toBeUndefined();
    save(0, " New ");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("New");
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("accepts padded text when the trimmed value fits", () => {
    const onCommit = vi.fn();
    ask("Old", onCommit);
    save(0, "  Short  ");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Short");
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("does not open the iOS prompt on Android", () => {
    platform.OS = "android";
    ask("Old", vi.fn());
    expect(prompt).not.toHaveBeenCalled();
  });
});
