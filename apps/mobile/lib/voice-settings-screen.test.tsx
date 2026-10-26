// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import VoiceSettings from "../app/(settings)/voice";
import { saveDeviceVoiceEnabled } from "./device-voice";
import { queryClient } from "./query";

const mocks = vi.hoisted(() => ({
  calls: vi.fn(),
  waiting: vi.fn(),
  saveCalls: vi.fn(),
  saveWaiting: vi.fn(),
  cue: vi.fn(),
  focused: true,
  failStatus: false,
  loadDevice: vi.fn(),
  reads: [] as string[],
  t: (text: string) => text,
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => void) => {
    useEffect(() => {
      if (mocks.focused) callback();
    }, [callback, mocks.focused]);
  },
  useLocalSearchParams: () => ({}),
}));
vi.mock("./call-sounds", () => ({
  loadCallSoundsEnabled: mocks.calls,
  loadWaitSoundEnabled: mocks.waiting,
  saveCallSoundsEnabled: mocks.saveCalls,
  saveWaitSoundEnabled: mocks.saveWaiting,
  playCallCue: mocks.cue,
}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async () => ({ apiBase: "https://app.example.test", headers: {} }),
  rpc: async (method: string) => {
    if (mocks.failStatus && method === "voice/status") throw new Error("offline");
    mocks.reads.push(method);
    if (method === "voice/catalog")
      return [{ id: "elevenlabs", name: "ElevenLabs", description: "", transcribe: true }];
    return method === "voice/status" ? { configured: false, ready: false, provider: null } : [];
  },
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./device-voice", () => ({
  loadDeviceVoiceEnabled: mocks.loadDevice,
  saveDeviceVoiceEnabled: vi.fn(),
}));
vi.mock("./voice", () => ({ speakText: vi.fn() }));
vi.mock("./i18n", () => ({ t: mocks.t, useI18n: () => ({ t: mocks.t }) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("../components/row-accessories", () => ({ Checkmark: () => null, Chevron: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
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
  queryClient.clear();
  mocks.focused = true;
  mocks.failStatus = false;
  mocks.loadDevice.mockReset().mockResolvedValue(false);
  mocks.reads.length = 0;
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

it("offers a retry when the first load fails, then loads the providers again", async () => {
  mocks.failStatus = true;
  await render();
  const retry = () =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === "Retry");
  expect(container.textContent).toContain("offline");
  expect(container.textContent).not.toContain("ElevenLabs");
  const statusReads = () => mocks.reads.filter((method) => method === "voice/status").length;
  expect(statusReads()).toBe(0);

  mocks.failStatus = false;
  await act(async () => retry()!.click());
  expect(statusReads()).toBe(1);
  expect(container.textContent).toContain("ElevenLabs");
  expect(container.textContent).not.toContain("offline");
  expect(retry()).toBeUndefined();
});

it("clears a failed refresh's banner once a provider choice succeeds", async () => {
  await render();
  expect(container.textContent).toContain("ElevenLabs");
  mocks.focused = false;
  await render();
  mocks.failStatus = true;
  mocks.focused = true;
  await render();
  expect(container.textContent).toContain("offline");

  mocks.failStatus = false;
  const provider = [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("ElevenLabs"),
  );
  await act(async () => provider!.click());
  expect(container.textContent).not.toContain("offline");
});

it("keeps Retry when saving 'This device' fails before the first load succeeds", async () => {
  mocks.failStatus = true;
  await render();
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label));
  expect(button("Retry")).toBeDefined();

  vi.mocked(saveDeviceVoiceEnabled).mockRejectedValueOnce(new Error("write failed"));
  await act(async () => button("This device")!.click());
  expect(container.textContent).toContain("write failed");
  expect(button("Retry")).toBeDefined();

  mocks.failStatus = false;
  await act(async () => button("Retry")!.click());
  expect(container.textContent).toContain("ElevenLabs");
  expect(button("Retry")).toBeUndefined();
});

it("keeps Retry when saving 'This device' succeeds before the first load does", async () => {
  mocks.failStatus = true;
  await render();
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label));
  await act(async () => button("This device")!.click());
  expect(saveDeviceVoiceEnabled).toHaveBeenCalledWith(true);
  expect(button("Retry")).toBeDefined();

  mocks.failStatus = false;
  await act(async () => button("Retry")!.click());
  expect(container.textContent).toContain("ElevenLabs");
  expect(button("Retry")).toBeUndefined();
});

it("keeps a device-voice read error after Retry reloads the providers", async () => {
  mocks.failStatus = true;
  mocks.loadDevice.mockRejectedValueOnce(new Error("device read failed"));
  await render();
  const retry = () =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === "Retry");
  expect(container.textContent).toContain("device read failed");

  mocks.failStatus = false;
  await act(async () => retry()!.click());
  expect(container.textContent).toContain("ElevenLabs");
  expect(container.textContent).toContain("device read failed");
});
