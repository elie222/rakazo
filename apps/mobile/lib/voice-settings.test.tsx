// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import VoiceSettings from "../app/(settings)/voice";

const state = vi.hoisted(() => ({ rpc: vi.fn(), load: vi.fn(), save: vi.fn() }));
const t = (text: string) => text;
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => void) => useEffect(callback, [callback]),
}));
vi.mock("./api", () => ({ rpc: state.rpc }));
vi.mock("./device-voice", () => ({
  loadDeviceVoiceEnabled: state.load,
  saveDeviceVoiceEnabled: state.save,
}));
vi.mock("./call-sounds", () => ({
  loadCallSoundsEnabled: async () => true,
  loadWaitSoundEnabled: async () => true,
  saveCallSoundsEnabled: vi.fn(),
  saveWaitSoundEnabled: vi.fn(),
  playCallCue: vi.fn(),
}));
vi.mock("./voice", () => ({ speakText: vi.fn() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("./i18n", () => ({ t: (text: string) => text, useI18n: () => ({ t }) }));
vi.mock("../components/row-accessories", () => ({
  Checkmark: () => <span data-testid="checkmark" />,
}));
vi.mock("../components/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress, disabled }: ButtonProps & { label: string }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
type ButtonProps = {
  children?: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  accessibilityState?: { selected: boolean };
};
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    ActivityIndicator: () => null,
    StyleSheet: { create: (styles: unknown) => styles },
    Pressable: ({ children, onPress, disabled, accessibilityState }: ButtonProps) => (
      <button
        type="button"
        disabled={disabled}
        aria-pressed={accessibilityState?.selected}
        onClick={onPress}
      >
        {children}
      </button>
    ),
    TextInput: ({ accessibilityLabel, value }: { accessibilityLabel: string; value: string }) => (
      <input aria-label={accessibilityLabel} value={value} readOnly />
    ),
  };
});

const catalog = [
  { id: "fish-audio", name: "Fish Audio", transcribe: true },
  { id: "other", name: "Other provider", transcribe: false },
  { id: "new", name: "New provider", transcribe: false },
];
const credentials = [
  { id: "fish", provider: "fish-audio", voiceId: "fish-voice", speechModel: "speech-model" },
  { id: "other", provider: "other", voiceId: "other-voice" },
];
let activeProvider: string;
let root: Root;
let container: HTMLDivElement;
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function selected(label: string) {
  expect(button(label).getAttribute("aria-pressed")).toBe("true");
  expect(button(label).querySelector('[data-testid="checkmark"]')).not.toBeNull();
}
function unselected(label: string) {
  expect(button(label).getAttribute("aria-pressed")).toBe("false");
  expect(button(label).querySelector('[data-testid="checkmark"]')).toBeNull();
}
async function render() {
  await act(async () => root.render(<VoiceSettings />));
}
async function click(label: string) {
  await act(async () => button(label).click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  activeProvider = "fish-audio";
  state.load.mockReset().mockResolvedValue(true);
  state.save.mockReset().mockResolvedValue(undefined);
  state.rpc.mockReset().mockImplementation(async (proc: string, args?: { provider: string }) => {
    if (proc === "voice/catalog") return catalog;
    if (proc === "voice/credentials") return credentials;
    if (proc === "voice/setVoice") activeProvider = args!.provider;
    if (proc === "voice/status" || proc === "voice/setVoice") {
      return { configured: true, ready: true, provider: activeProvider, voiceId: "saved-voice" };
    }
    if (proc === "voice/voices")
      return [{ id: `${args!.provider}-voice`, label: `${args!.provider} voice` }];
    throw new Error(`Unexpected RPC: ${proc}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("selects only This device and hides all provider controls until it is turned off", async () => {
  await render();
  selected("This device");
  for (const entry of catalog) unselected(entry.name);
  expect(container.querySelector("input")).toBeNull();
  expect(container.textContent).not.toContain("Replace key");
  expect(container.textContent).not.toContain("Disconnect");
  expect(container.textContent).not.toContain("Speech model");
  expect(container.textContent).not.toContain("fish-audio voice");
  await click("This device");
  selected("Fish Audio");
  unselected("This device");
  expect(container.querySelector('input[aria-label="API key"]')).not.toBeNull();
  expect(container.querySelector('input[aria-label="Speech model"]')?.getAttribute("value")).toBe(
    "speech-model",
  );
  expect(container.textContent).toContain("Replace key");
  expect(container.textContent).toContain("Disconnect");
  expect(container.textContent).toContain("fish-audio voice");
});

it("disables provider rows until the saved device preference has loaded", async () => {
  let finish!: (value: boolean) => void;
  state.load.mockReturnValue(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  for (const entry of catalog) expect(button(entry.name).disabled).toBe(true);
  await click("Other provider");
  expect(state.save).not.toHaveBeenCalled();
  expect(state.rpc).not.toHaveBeenCalledWith("voice/setVoice", expect.anything());
  await act(async () => finish(true));
  expect(button("Other provider").disabled).toBe(false);
  selected("This device");
});

it("saves device voice off before activating a connected provider's saved voice", async () => {
  await render();
  let finish!: () => void;
  state.save.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await click("Other provider");
  expect(state.save).toHaveBeenCalledWith(false);
  expect(state.rpc).not.toHaveBeenCalledWith("voice/setVoice", expect.anything());
  expect(button("Fish Audio").disabled).toBe(true);
  await act(async () => finish());
  expect(state.rpc).toHaveBeenCalledWith("voice/setVoice", {
    provider: "other",
    voiceId: "other-voice",
  });
  selected("Other provider");
  unselected("This device");
  unselected("Fish Audio");
  expect(container.textContent).toContain("other voice");
});

it("keeps the device selected if saving its preference fails", async () => {
  await render();
  state.save.mockRejectedValueOnce(new Error("Could not save that preference"));
  await click("Other provider");
  selected("This device");
  unselected("Other provider");
  expect(container.querySelector("input")).toBeNull();
  expect(state.rpc).not.toHaveBeenCalledWith("voice/setVoice", expect.anything());
  expect(container.textContent).toContain("Could not save that preference");
  await click("This device");
  selected("Fish Audio");
});

it.each([true, false])(
  "restores the previous provider and device preference after activation fails (device: %s)",
  async (device) => {
    state.load.mockResolvedValue(device);
    await render();
    const original = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((proc: string, args?: { provider: string }) =>
      proc === "voice/setVoice"
        ? Promise.reject(new Error("Could not save that voice"))
        : original(proc, args),
    );
    await click("Other provider");
    unselected("Other provider");
    expect(container.textContent).toContain("Could not save that voice");
    if (device) {
      selected("This device");
      expect(state.save.mock.calls).toEqual([[false], [true]]);
      await click("This device");
    } else {
      expect(state.save).not.toHaveBeenCalled();
    }
    selected("Fish Audio");
  },
);

it.each(["Fish Audio", "New provider"])(
  "selects %s without activating an already active or unconnected provider",
  async (name) => {
    await render();
    await click(name);
    selected(name);
    unselected("This device");
    expect(state.rpc).not.toHaveBeenCalledWith("voice/setVoice", expect.anything());
    if (name === "New provider") expect(container.textContent).toContain("Connect");
  },
);

it("clears stale voices if the refresh fails after activating a provider", async () => {
  state.load.mockResolvedValue(false);
  await render();
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc: string, args?: { provider: string }) =>
    proc === "voice/catalog"
      ? Promise.reject(new Error("Could not load voice settings"))
      : original(proc, args),
  );
  await click("Other provider");
  selected("Other provider");
  expect(container.textContent).not.toContain("fish-audio voice");
  expect(container.textContent).toContain("Could not load voice settings");
  expect(state.save).not.toHaveBeenCalled();
});
