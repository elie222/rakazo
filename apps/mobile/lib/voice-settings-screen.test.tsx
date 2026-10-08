// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import VoiceSettings from "../app/(settings)/voice";

const mocks = vi.hoisted(() => ({
  calls: vi.fn(),
  waiting: vi.fn(),
  saveCalls: vi.fn(),
  saveWaiting: vi.fn(),
  cue: vi.fn(),
  focused: true,
  t: (text: string) => text,
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => void) => {
    useEffect(() => {
      if (mocks.focused) callback();
    }, [callback, mocks.focused]);
  },
}));
vi.mock("./call-sounds", () => ({
  loadCallSoundsEnabled: mocks.calls,
  loadWaitSoundEnabled: mocks.waiting,
  saveCallSoundsEnabled: mocks.saveCalls,
  saveWaitSoundEnabled: mocks.saveWaiting,
  playCallCue: mocks.cue,
}));
vi.mock("./api", () => ({
  rpc: async (method: string) =>
    method === "voice/status" ? { configured: false, ready: false, provider: null } : [],
}));
vi.mock("./device-voice", () => ({
  loadDeviceVoiceEnabled: async () => false,
  saveDeviceVoiceEnabled: vi.fn(),
}));
vi.mock("./voice", () => ({ speakText: vi.fn() }));
vi.mock("./i18n", () => ({ t: mocks.t, useI18n: () => ({ t: mocks.t }) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("../components/row-accessories", () => ({ Checkmark: () => null, Chevron: () => null }));
vi.mock("../components/native-action-button", () => ({ NativeActionButton: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-switch", () => ({
  NativeSwitch: (props: {
    accessibilityLabel: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={props.accessibilityLabel}
      checked={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onValueChange(event.target.checked)}
    />
  ),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Text: View,
    ActivityIndicator: () => null,
    TextInput: () => null,
    Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
      <button type="button" onClick={onPress}>
        {children}
      </button>
    ),
    StyleSheet: { create: (styles: unknown) => styles },
    useWindowDimensions: () => ({ fontScale: 1 }),
  };
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.focused = true;
  mocks.calls.mockResolvedValue(true);
  mocks.waiting.mockResolvedValue(true);
  mocks.saveCalls.mockResolvedValue(undefined);
  mocks.saveWaiting.mockResolvedValue(undefined);
  mocks.cue.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<VoiceSettings />));
}
function toggle(label: string) {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}

it.each([
  ["Call sounds", "calls", "Waiting sound"],
  ["Waiting sound", "waiting", "Call sounds"],
] as const)("keeps %s off and disabled when its read fails", async (label, read, other) => {
  mocks[read].mockRejectedValue(new Error("Could not load voice settings"));
  await render();
  expect(toggle(label).checked).toBe(false);
  expect(toggle(label).disabled).toBe(true);
  expect(toggle(other).checked).toBe(true);
  expect(toggle(other).disabled).toBe(false);
  expect(container.textContent).toContain("Could not load voice settings");
});

it("disables a previously loaded switch after a subsequent read failure", async () => {
  await render();
  expect(toggle("Call sounds").checked).toBe(true);
  mocks.focused = false;
  await render();
  mocks.calls.mockRejectedValue(new Error("Could not load voice settings"));
  mocks.focused = true;
  await render();
  expect(toggle("Call sounds").checked).toBe(false);
  expect(toggle("Call sounds").disabled).toBe(true);
});

it("previews only when call sounds are turned on and saved", async () => {
  mocks.calls.mockResolvedValue(false);
  await render();
  await act(async () => toggle("Call sounds").click());
  expect(mocks.saveCalls).toHaveBeenCalledWith(true);
  expect(mocks.cue).toHaveBeenCalledWith("start");
  await act(async () => toggle("Call sounds").click());
  expect(mocks.saveCalls).toHaveBeenLastCalledWith(false);
  expect(mocks.cue).toHaveBeenCalledTimes(1);
});

it("rolls a failed save back without playing a preview", async () => {
  mocks.calls.mockResolvedValue(false);
  mocks.saveCalls.mockRejectedValue(new Error("write failed"));
  await render();
  await act(async () => toggle("Call sounds").click());
  expect(toggle("Call sounds").checked).toBe(false);
  expect(mocks.cue).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Could not save that preference");
});
