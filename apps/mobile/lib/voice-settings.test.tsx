// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import VoiceSettings from "../app/(settings)/voice";
import { queryClient } from "./query";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  params: {} as { spaceId?: string },
  held: null as Promise<void> | null,
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => void) => useEffect(callback, [callback]),
  useLocalSearchParams: () => state.params,
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async (spaceId?: string) => ({
    apiBase: "https://app.example.test",
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./device-voice", () => ({
  loadDeviceVoiceEnabled: state.load,
  saveDeviceVoiceEnabled: state.save,
}));
vi.mock("./call-sounds", () => ({
  loadCallGreetingEnabled: async () => true,
  loadCallSoundsEnabled: async () => true,
  loadWaitSoundEnabled: async () => true,
  saveCallSoundsEnabled: vi.fn(),
  saveWaitSoundEnabled: vi.fn(),
  playCallCue: vi.fn(),
}));
vi.mock("./voice", () => ({ speakText: vi.fn() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
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
    ActivityIndicator: () => <span>Loading</span>,
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
    TextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
      onBlur,
      placeholder,
    }: {
      accessibilityLabel: string;
      value: string;
      onChangeText?: (value: string) => void;
      onBlur?: () => void;
      placeholder?: string;
    }) => (
      <input
        aria-label={accessibilityLabel}
        value={value}
        onChange={(event) => onChangeText?.(event.currentTarget.value)}
        onBlur={onBlur}
        placeholder={placeholder}
      />
    ),
  };
});

const catalog = [
  { id: "fish-audio", name: "Fish Audio", transcribe: true, speechModel: true },
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
  state.params = {};
  queryClient.clear();
  activeProvider = "fish-audio";
  state.load.mockReset().mockResolvedValue(true);
  state.save.mockReset().mockResolvedValue(undefined);
  state.held = null;
  state.rpc.mockReset().mockImplementation(async (proc: string, args?: { provider: string }) => {
    if (state.held) await state.held;
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

it("falls back to an available provider when the saved provider is hidden", async () => {
  state.load.mockResolvedValue(false);
  activeProvider = "openai-compatible";
  const original = state.rpc.getMockImplementation()!;
  let connected = true;
  state.rpc.mockImplementation((proc: string, args?: { provider: string }) => {
    if (proc === "voice/credentials" && connected)
      return [{ id: "self-hosted", provider: "openai-compatible", voiceId: "voice" }];
    if (proc === "voice/disconnect") {
      connected = false;
      return undefined;
    }
    return original(proc, args);
  });
  await render();
  selected("Fish Audio");
  expect(container.querySelector('input[aria-label="Server URL"]')).toBeNull();
  expect(state.rpc).not.toHaveBeenCalledWith("voice/voices", {
    provider: "openai-compatible",
  });
  await click("Disconnect Self-hosted");
  expect(state.rpc).toHaveBeenCalledWith("voice/disconnect", { provider: "openai-compatible" });
  expect(container.textContent).not.toContain("Disconnect Self-hosted");
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
    scope: "account",
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
      expect(state.save.mock.calls).toEqual([[false]]);
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
  expect(state.save.mock.calls).toEqual([[false]]);
});

it("edits a Space's override in that Space, leaving this device's voice and sounds out", async () => {
  state.params = { spaceId: "space-other" };
  await render();
  const spaceContext = {
    requestContext: {
      apiBase: "https://app.example.test",
      headers: { "x-rakazo-space-id": "space-other" },
    },
  };
  // Reads also carry an abort signal.
  const spaceRead = expect.objectContaining(spaceContext);
  expect(state.rpc).toHaveBeenCalledWith("voice/status", { scope: "space" }, spaceRead);
  expect(state.rpc).toHaveBeenCalledWith("voice/credentials", { scope: "space" }, spaceRead);
  expect(state.load).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("This device");
  expect(container.textContent).not.toContain("Call sounds");
  selected("Fish Audio");
  await click("Other provider");
  expect(state.rpc).toHaveBeenCalledWith(
    "voice/setVoice",
    { provider: "other", voiceId: "other-voice", scope: "space" },
    spaceContext,
  );
  selected("Other provider");
});

async function revisit() {
  await act(async () => root.unmount());
  root = createRoot(container);
  let release!: () => void;
  state.held = new Promise((resolve) => {
    release = resolve;
  });
  await render();
  return async () => {
    await act(async () => release());
  };
}

it("paints a revisit from cache without a spinner and refreshes behind it", async () => {
  state.load.mockResolvedValue(false);
  await render();
  expect(container.textContent).toContain("fish-audio voice");
  const calls = state.rpc.mock.calls.length;
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc: string, args?: { provider: string }) =>
    proc === "voice/voices"
      ? Promise.resolve([{ id: "fish-new", label: "Refreshed voice" }])
      : original(proc, args),
  );

  const release = await revisit();
  expect(container.textContent).not.toContain("Loading");
  expect(container.textContent).toContain("fish-audio voice");
  expect(state.rpc.mock.calls.length).toBeGreaterThan(calls);

  await release();
  expect(container.textContent).toContain("Refreshed voice");
});

it("keeps a field typed into while the opening refresh is in flight", async () => {
  state.load.mockResolvedValue(false);
  await render();
  const release = await revisit();
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Speech model"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "typed");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await release();
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Speech model"]')!.value).toBe(
    "typed",
  );
});

it("keeps a saved speech model when an opening read started before the save lands after it", async () => {
  state.load.mockResolvedValue(false);
  await render();
  await act(async () => root.unmount());
  root = createRoot(container);
  let serverSpeechModel = "speech-model";
  let releaseCatalog!: () => void;
  const catalogHeld = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, args?: { provider: string }) => {
    if (proc === "voice/catalog") await catalogHeld;
    if (proc === "voice/credentials") {
      return credentials.map((entry) =>
        entry.id === "fish" ? { ...entry, speechModel: serverSpeechModel } : entry,
      );
    }
    if (proc === "voice/setSpeechModel") {
      serverSpeechModel = "saved-model";
      return { ...credentials[0], speechModel: serverSpeechModel };
    }
    return original(proc, args);
  });
  await render();
  const input = () =>
    container.querySelector<HTMLInputElement>('input[aria-label="Speech model"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input(),
      "saved-model",
    );
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input().focus();
    input().blur();
  });
  expect(state.rpc).toHaveBeenCalledWith("voice/setSpeechModel", {
    provider: "fish-audio",
    scope: "account",
    speechModel: "saved-model",
  });
  await act(async () => releaseCatalog());
  await vi.waitFor(() => expect(input().value).toBe("saved-model"));
});

async function typeInto(label: string, text: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function withLinkedProvider(credential: { hasKey: boolean } | null) {
  const original = state.rpc.getMockImplementation()!;
  let saved = credential && { id: "linked", provider: "linked", voiceId: "", ...credential };
  state.rpc.mockImplementation((proc: string, args?: { provider: string }) => {
    if (proc === "voice/catalog")
      return [
        ...catalog,
        { id: "linked", name: "Linked", transcribe: true, modelConnection: true },
      ];
    if (proc === "voice/credentials") return saved ? [...credentials, saved] : credentials;
    if (proc === "voice/connect") {
      saved = { id: "linked", provider: "linked", voiceId: "", hasKey: false };
      return saved;
    }
    return original(proc, args);
  });
}

it("connects through the account's model connection with no key, then offers no key to replace", async () => {
  state.load.mockResolvedValue(false);
  withLinkedProvider(null);
  await render();
  await click("Linked");
  const key = () => container.querySelector<HTMLInputElement>('input[aria-label="API key"]');
  expect(key()?.placeholder).toBe("Optional");
  expect(button("Connect").disabled).toBe(false);
  // A key the user does type must still be a whole one.
  await typeInto("API key", "short");
  expect(button("Connect").disabled).toBe(true);
  await typeInto("API key", "");
  await click("Connect");
  expect(state.rpc).toHaveBeenCalledWith("voice/connect", {
    provider: "linked",
    scope: "account",
    apiKey: "",
  });
  expect(key()).toBeNull();
  const labels = [...container.querySelectorAll("button")].map((item) => item.textContent);
  expect(labels).not.toContain("Connect");
  expect(labels).not.toContain("Replace key");
  expect(button("Disconnect").disabled).toBe(false);
  expect(container.textContent).toContain("linked voice");
});

it("still needs a whole key to replace a key saved for a model-connection provider", async () => {
  state.load.mockResolvedValue(false);
  withLinkedProvider({ hasKey: true });
  await render();
  await click("Linked");
  expect(
    container.querySelector<HTMLInputElement>('input[aria-label="API key"]')?.placeholder,
  ).toBe("Paste a replacement key");
  expect(button("Replace key").disabled).toBe(true);
  await typeInto("API key", "a-whole-key");
  expect(button("Replace key").disabled).toBe(false);
});

it("keeps a successful connection when the following settings read fails", async () => {
  state.load.mockResolvedValue(false);
  withLinkedProvider(null);
  await render();
  await click("Linked");
  const original = state.rpc.getMockImplementation()!;
  let connected = false;
  state.rpc.mockImplementation(async (proc, args) => {
    if (connected && proc === "voice/status") throw new Error();
    const result = await original(proc, args);
    if (proc === "voice/connect") connected = true;
    return result;
  });
  await click("Connect");
  expect(container.textContent).toContain("Could not load voice settings");
  expect(container.textContent).not.toContain("Could not connect");
  expect(button("Disconnect")).toBeDefined();
  expect(container.querySelector('input[aria-label="API key"]')).toBeNull();
});

it("reports a read failure separately after saving a voice", async () => {
  state.load.mockResolvedValue(false);
  await render();
  const original = state.rpc.getMockImplementation()!;
  let saved = false;
  state.rpc.mockImplementation(async (proc, args) => {
    if (saved && proc === "voice/status") throw new Error();
    const result = await original(proc, args);
    if (proc === "voice/setVoice") saved = true;
    return result;
  });
  await click("fish-audio voice");
  expect(container.textContent).toContain("Could not load voice settings");
  expect(container.textContent).not.toContain("Could not save that voice");
});

it("still reports a failed connection without pretending it was saved", async () => {
  state.load.mockResolvedValue(false);
  withLinkedProvider(null);
  await render();
  await click("Linked");
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc, args) => {
    if (proc === "voice/connect") throw new Error();
    return original(proc, args);
  });
  await click("Connect");
  expect(container.textContent).toContain("Could not connect");
  expect(container.textContent).not.toContain("Could not load voice settings");
  expect(container.textContent).not.toContain("Disconnect");
});

it("still reports a failed voice save and clears it on a successful retry", async () => {
  state.load.mockResolvedValue(false);
  await render();
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc, args) => {
    if (proc === "voice/setVoice") throw new Error();
    return original(proc, args);
  });
  await click("fish-audio voice");
  expect(container.textContent).toContain("Could not save that voice");
  expect(container.textContent).not.toContain("Could not load voice settings");
  state.rpc.mockImplementation(original);
  await click("fish-audio voice");
  expect(container.textContent).not.toContain("Could not save that voice");
});

it.each(["voice/status", "voice/voices"])(
  "discards old voice options after reconnect when %s fails, including on revisit",
  async (failedRead) => {
    state.load.mockResolvedValue(false);
    await render();
    expect(container.textContent).toContain("fish-audio voice");
    const original = state.rpc.getMockImplementation()!;
    let connected = false;
    state.rpc.mockImplementation((proc, args) => {
      if (proc === "voice/connect") {
        connected = true;
        return { ...credentials[0], voiceId: "replacement-voice" };
      }
      if (connected && proc === failedRead) throw new Error();
      if (connected && proc === "voice/credentials")
        return [{ ...credentials[0], voiceId: "replacement-voice" }];
      return original(proc, args);
    });
    await typeInto("API key", "replacement-key");
    await click("Replace key");
    expect(container.textContent).not.toContain("fish-audio voice");
    state.rpc.mockRejectedValue(new Error());
    await act(async () => root.render(null));
    await render();
    expect(container.textContent).not.toContain("fish-audio voice");
  },
);

it("keeps a newly connected voice ready for samples across a failed refresh and revisit", async () => {
  state.load.mockResolvedValue(false);
  withLinkedProvider(null);
  const original = state.rpc.getMockImplementation()!;
  let connected = false;
  state.rpc.mockImplementation((proc, args) => {
    if (proc === "voice/connect") {
      connected = true;
      return { id: "linked", provider: "linked", voiceId: "new-voice", hasKey: false };
    }
    if (connected) throw new Error();
    if (proc === "voice/status") return { configured: false, ready: false, provider: null };
    return original(proc, args);
  });
  await render();
  await click("Linked");
  expect(container.textContent).not.toContain("Hear a sample");
  await click("Connect");
  expect(container.textContent).toContain("Hear a sample");
  await act(async () => root.render(null));
  await render();
  selected("Linked");
  expect(container.textContent).toContain("Hear a sample");
});

it("keeps the saved voice selected on revisit when the follow-up reads fail", async () => {
  state.load.mockResolvedValue(false);
  const original = state.rpc.getMockImplementation()!;
  let saved = false;
  state.rpc.mockImplementation((proc, args) => {
    if (proc === "voice/setVoice") {
      saved = true;
      return { configured: true, ready: true, provider: "fish-audio", voiceId: "new-voice" };
    }
    if (saved) throw new Error();
    if (proc === "voice/voices")
      return [
        { id: "fish-voice", label: "Old voice" },
        { id: "new-voice", label: "New voice" },
      ];
    return original(proc, args);
  });
  await render();
  await click("New voice");
  await act(async () => root.render(null));
  await render();
  selected("New voice");
  unselected("Old voice");
});
