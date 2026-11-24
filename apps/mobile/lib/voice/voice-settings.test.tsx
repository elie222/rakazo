// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import VoiceSettings from "../../app/(settings)/voice";
import { modelConnectionRequest } from "../models/model-connection-request";
import { queryClient } from "../query/query";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  params: {} as { spaceId?: string },
  held: null as Promise<void> | null,
  push: vi.fn(),
}));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => void) => useEffect(callback, [callback]),
  useLocalSearchParams: () => state.params,
  useRouter: () => ({ push: state.push }),
}));
vi.mock("../api/api", () => ({
  rpc: state.rpc,
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async (spaceId?: string) => ({
    apiBase: "https://app.example.test",
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./device-voice", () => ({
  loadDeviceVoiceEnabled: state.load,
  saveDeviceVoiceEnabled: state.save,
}));
vi.mock("expo-secure-store", () => ({ getItemAsync: async () => null }));
vi.mock("../calls/call-sounds", () => ({
  loadCallGreetingEnabled: async () => true,
  loadCallSoundsEnabled: async () => true,
  loadWaitSoundEnabled: async () => true,
  saveCallSoundsEnabled: vi.fn(),
  saveWaitSoundEnabled: vi.fn(),
  playCallCue: vi.fn(),
}));
vi.mock("./voice", () => ({ speakText: vi.fn() }));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../native/native", () => ({
  native: {},
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("../../components/ui/row-accessories", () => ({
  Checkmark: () => <span data-testid="checkmark" />,
}));
vi.mock("../../components/ui/menu-picker", () => ({
  MenuPicker: ({
    choices,
    value,
    onChange,
    disabled,
  }: {
    disabled?: boolean;
    choices: { key: string; label: string }[];
    value: string;
    onChange: (key: string) => void;
  }) => (
    <div>
      {choices.map((choice) => (
        <button
          key={choice.key}
          type="button"
          disabled={disabled}
          aria-pressed={choice.key === value}
          onClick={() => onChange(choice.key)}
        >
          {choice.label}
          {choice.key === value ? <span data-testid="checkmark" /> : null}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../../components/native/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress, disabled }: ButtonProps & { label: string }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/models/model-connection-fields", () => ({
  DisclosureRow: ({
    label,
    expanded,
    onPress,
  }: {
    label: string;
    expanded: boolean;
    onPress: () => void;
  }) => (
    <button type="button" aria-expanded={expanded} onClick={onPress}>
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
  state.push.mockReset();
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

it("selects only This device and hides provider controls until a provider is chosen", async () => {
  await render();
  selected("This device");
  for (const entry of catalog) unselected(entry.name);
  expect(container.querySelector("input")).toBeNull();
  expect(container.textContent).not.toContain("Replace key");
  expect(container.textContent).not.toContain("Disconnect");
  expect(container.textContent).not.toContain("Speech model");
  expect(container.textContent).not.toContain("fish-audio voice");
  await click("Fish Audio");
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

it.each([true, false])("ignores reselecting the current provider (device: %s)", async (device) => {
  state.load.mockResolvedValue(device);
  await render();
  const label = device ? "This device" : "Fish Audio";
  selected(label);
  state.rpc.mockClear();

  await click(label);

  expect(state.save).not.toHaveBeenCalled();
  expect(state.rpc).not.toHaveBeenCalled();
  selected(label);
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

it("keeps selected voices when a hidden provider disconnects and the read fails", async () => {
  state.load.mockResolvedValue(false);
  const original = state.rpc.getMockImplementation()!;
  let disconnected = false;
  state.rpc.mockImplementation((proc: string, args?: { provider: string }) => {
    if (proc === "voice/disconnect") {
      disconnected = true;
      return undefined;
    }
    if (proc === "voice/catalog" && disconnected) return Promise.reject({});
    if (proc === "voice/credentials")
      return [
        { id: "selected", provider: "fish-audio", voiceId: "voice" },
        { id: "hidden", provider: "openai-compatible", voiceId: "voice" },
      ];
    return original(proc, args);
  });
  await render();
  expect(container.textContent).toContain("fish-audio voice");
  await click("Disconnect Self-hosted");
  expect(container.textContent).toContain("fish-audio voice");
  expect(container.textContent).toContain("Could not load voice settings");
  expect(container.textContent).not.toContain("Disconnect Self-hosted");
});

it("disables provider rows until the saved device preference has loaded", async () => {
  const finish = deferred<boolean>();
  state.load.mockReturnValue(finish.promise);
  await render();
  for (const entry of catalog) expect(button(entry.name).disabled).toBe(true);
  await click("Other provider");
  expect(state.save).not.toHaveBeenCalled();
  expect(state.rpc).not.toHaveBeenCalledWith("voice/setVoice", expect.anything());
  await act(async () => finish.resolve(true));
  expect(button("Other provider").disabled).toBe(false);
  selected("This device");
});

it("saves device voice off before activating a connected provider's saved voice", async () => {
  await render();
  const finish = deferred();
  state.save.mockReturnValue(finish.promise);
  await click("Other provider");
  expect(state.save).toHaveBeenCalledWith(false);
  expect(state.rpc).not.toHaveBeenCalledWith("voice/setVoice", expect.anything());
  expect(button("Fish Audio").disabled).toBe(true);
  await act(async () => finish.resolve());
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
  await click("Fish Audio");
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
      await click("Fish Audio");
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

it("keeps a disconnect when the read after it fails", async () => {
  state.load.mockResolvedValue(false);
  await render();
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc: string, args?: { provider: string }) => {
    if (proc === "voice/disconnect") return undefined;
    // A body without a message, so the text shown is the caller's own fallback.
    if (proc === "voice/catalog") return Promise.reject({});
    return original(proc, args);
  });
  expect(container.textContent).toContain("fish-audio voice");
  await click("Disconnect");
  expect(state.rpc).toHaveBeenCalledWith("voice/disconnect", { provider: "fish-audio" });
  // Its voices go with the key: picking one would only fail on the server.
  expect(container.textContent).not.toContain("fish-audio voice");
  expect(container.textContent).toContain("Could not load voice settings");
  expect(container.textContent).not.toContain("Could not disconnect");
  expect(container.textContent).not.toContain("Disconnect");
  expect(container.textContent).toContain("Connect");
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
  const release = deferred();
  state.held = release.promise;
  await render();
  return async () => {
    await act(async () => release.resolve());
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

it("keeps a typed transcription key with the address it was typed for", async () => {
  state.load.mockResolvedValue(false);
  activeProvider = "openai-compatible";
  let sttEndpoint = "http://127.0.0.1:9000/v1";
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, args?: { provider: string }) => {
    if (proc === "voice/catalog") {
      if (state.held) await state.held;
      return [{ id: "openai-compatible", name: "Self-hosted", transcribe: true }];
    }
    if (proc === "voice/credentials") {
      if (state.held) await state.held;
      return [
        {
          id: "self-hosted",
          provider: "openai-compatible",
          voiceId: "voice",
          endpoint: "http://127.0.0.1:8000/v1",
          sttEndpoint,
        },
      ];
    }
    return original(proc, args);
  });
  await render();
  const field = () =>
    container.querySelector<HTMLInputElement>('input[aria-label="Transcription server URL"]')!;
  expect(field().value).toBe("http://127.0.0.1:9000/v1");
  // Another device moved transcription while this screen was closed.
  sttEndpoint = "http://127.0.0.1:9100/v1";
  const release = await revisit();
  const key = container.querySelector<HTMLInputElement>(
    'input[aria-label="Transcription API key"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      key,
      "stt-test-key",
    );
    key.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await release();
  expect(field().value).toBe("http://127.0.0.1:9000/v1");
});

it("keeps edits typed while a reconnect runs and shows the saved values for the rest", async () => {
  state.load.mockResolvedValue(false);
  activeProvider = "openai-compatible";
  const saved = {
    id: "self-hosted",
    provider: "openai-compatible",
    voiceId: "voice",
    endpoint: "http://127.0.0.1:8000/v1",
    sttEndpoint: "",
    sttModel: "old-model",
  };
  const connectHeld = deferred();
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, args?: { provider: string }) => {
    if (proc === "voice/catalog")
      return [{ id: "openai-compatible", name: "Self-hosted", transcribe: true }];
    if (proc === "voice/credentials") return [saved];
    if (proc === "voice/connect") {
      await connectHeld.promise;
      // Another device moves transcription before the refresh that follows this connect.
      Object.assign(saved, { sttEndpoint: "http://127.0.0.1:9300/v1", sttModel: "sent-model" });
      return { ok: true };
    }
    return original(proc, args);
  });
  await render();
  const field = (label: string) =>
    container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const type = async (label: string, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        field(label),
        value,
      );
      field(label).dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await type("Transcription server URL", "http://127.0.0.1:9200");
  await type("Transcription model", "sent-model");
  await type("Transcription API key", "sent-key");
  await click("Reconnect");
  expect(state.rpc).toHaveBeenCalledWith(
    "voice/connect",
    expect.objectContaining({ sttBaseUrl: "http://127.0.0.1:9200", sttApiKey: "sent-key" }),
  );
  await type("Transcription API key", "newer-key");
  await type("Speech model", "newer-tts");
  await act(async () => connectHeld.resolve());
  await vi.waitFor(() => expect(field("Transcription model").value).toBe("sent-model"));
  // The key typed meanwhile stays with the address it was typed for, not the other server.
  expect(field("Transcription server URL").value).toBe("http://127.0.0.1:9200");
  expect(field("Transcription API key").value).toBe("newer-key");
  expect(field("Speech model").value).toBe("newer-tts");
});

it("keeps an API key typed during a reconnect with the server URL it was typed for", async () => {
  state.load.mockResolvedValue(false);
  activeProvider = "openai-compatible";
  const saved = {
    id: "self-hosted",
    provider: "openai-compatible",
    voiceId: "voice",
    endpoint: "https://speech-a.example/v1",
    sttEndpoint: "",
  };
  const connectHeld = deferred();
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, args?: { provider: string }) => {
    if (proc === "voice/catalog")
      return [{ id: "openai-compatible", name: "Self-hosted", transcribe: true }];
    if (proc === "voice/credentials") return [saved];
    if (proc === "voice/connect") {
      await connectHeld.promise;
      // Another device saves server B before the refresh that follows this connect.
      saved.endpoint = "https://speech-b.example/v1";
      return { ok: true };
    }
    return original(proc, args);
  });
  await render();
  const field = (label: string) =>
    container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await vi.waitFor(() => expect(field("Server URL").value).toBe("https://speech-a.example/v1"));
  await click("Reconnect");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field("API key"),
      "key-for-server-a",
    );
    field("API key").dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => connectHeld.resolve());
  await vi.waitFor(() =>
    expect(state.rpc.mock.calls.filter(([proc]) => proc === "voice/credentials").length).toBe(2),
  );
  expect(field("Server URL").value).toBe("https://speech-a.example/v1");
  expect(field("API key").value).toBe("key-for-server-a");

  await click("Reconnect");
  const connects = state.rpc.mock.calls.filter(([proc]) => proc === "voice/connect");
  expect(connects.at(-1)?.[1]).toMatchObject({
    baseUrl: "https://speech-a.example/v1",
    apiKey: "key-for-server-a",
  });
});

it("keeps a typed transcription key with its address when a voice is chosen", async () => {
  state.load.mockResolvedValue(false);
  activeProvider = "openai-compatible";
  const saved = {
    id: "self-hosted",
    provider: "openai-compatible",
    voiceId: "voice",
    endpoint: "http://127.0.0.1:8000/v1",
    sttEndpoint: "http://127.0.0.1:9200/v1",
  };
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, args?: { provider: string }) => {
    if (proc === "voice/catalog")
      return [{ id: "openai-compatible", name: "Self-hosted", transcribe: true }];
    if (proc === "voice/credentials") return [saved];
    if (proc === "voice/connect") return { ok: true };
    // Another device moves transcription while this voice is being saved.
    if (proc === "voice/setVoice") saved.sttEndpoint = "http://127.0.0.1:9300/v1";
    return original(proc, args);
  });
  await render();
  const field = (label: string) =>
    container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await vi.waitFor(() =>
    expect(field("Transcription server URL").value).toBe("http://127.0.0.1:9200/v1"),
  );
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field("Transcription API key"),
      "typed-key",
    );
    field("Transcription API key").dispatchEvent(new Event("input", { bubbles: true }));
  });
  await vi.waitFor(() => button("openai-compatible voice"));
  await click("openai-compatible voice");
  await vi.waitFor(() =>
    expect(state.rpc).toHaveBeenCalledWith("voice/setVoice", expect.anything()),
  );
  await click("Reconnect");
  expect(state.rpc).toHaveBeenCalledWith(
    "voice/connect",
    expect.objectContaining({ sttBaseUrl: "http://127.0.0.1:9200/v1", sttApiKey: "typed-key" }),
  );
});

it("keeps a saved speech model when an opening read started before the save lands after it", async () => {
  state.load.mockResolvedValue(false);
  await render();
  await act(async () => root.unmount());
  root = createRoot(container);
  let serverSpeechModel = "speech-model";
  const catalogHeld = deferred();
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, args?: { provider: string }) => {
    if (proc === "voice/catalog") await catalogHeld.promise;
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
  await act(async () => catalogHeld.resolve());
  await vi.waitFor(() => expect(input().value).toBe("saved-model"));
});

async function typeInto(label: string, text: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const personalPlan = { id: "model-connection-1", label: "Personal plan" };
const workPlan = { id: "model-connection-2", label: "Work plan" };
function withLinkedProvider(
  credential: { hasKey: boolean } | null,
  entry: { modelConnections?: { id: string; label: string }[]; modelSignIn?: string } = {
    modelConnections: [personalPlan],
  },
) {
  const original = state.rpc.getMockImplementation()!;
  let saved = credential && { id: "linked", provider: "linked", voiceId: "", ...credential };
  state.rpc.mockImplementation(
    (proc: string, args?: { provider: string; modelCredentialId?: string }) => {
      if (proc === "voice/catalog")
        return [...catalog, { id: "linked", name: "Linked", transcribe: true, ...entry }];
      if (proc === "voice/credentials") return saved ? [...credentials, saved] : credentials;
      if (proc === "voice/connect") {
        saved = {
          id: "linked",
          provider: "linked",
          voiceId: "",
          hasKey: !args?.modelCredentialId,
          ...(args?.modelCredentialId ? { modelCredentialId: args.modelCredentialId } : {}),
        };
        return saved;
      }
      return original(proc, args);
    },
  );
}
const keyField = () => container.querySelector<HTMLInputElement>('input[aria-label="API key"]');
function expectOnlyDisconnect() {
  expect(keyField()).toBeNull();
  const labels = [...container.querySelectorAll("button")].map((item) => item.textContent);
  expect(labels).not.toContain("Connect");
  expect(labels).not.toContain("Replace key");
  expect(labels.some((label) => label?.startsWith("Use "))).toBe(false);
  expect(labels).not.toContain("Or paste an API key");
  expect(button("Disconnect").disabled).toBe(false);
}

it.each([personalPlan, workPlan])(
  "connects through the model connection $label with no key, then offers only the other one",
  async (connection) => {
    state.load.mockResolvedValue(false);
    withLinkedProvider(null, { modelConnections: [personalPlan, workPlan] });
    await render();
    await click("Linked");
    // The key form folds behind the model connections.
    expect(keyField()).toBeNull();
    expect(button("Or paste an API key").getAttribute("aria-expanded")).toBe("false");
    await click(`Use ${connection.label}`);
    expect(state.rpc).toHaveBeenCalledWith("voice/connect", {
      provider: "linked",
      scope: "account",
      apiKey: "",
      modelCredentialId: connection.id,
    });
    const other = connection === personalPlan ? workPlan : personalPlan;
    const labels = [...container.querySelectorAll("button")].map((item) => item.textContent);
    expect(labels.filter((label) => label?.startsWith("Use "))).toEqual([`Use ${other.label}`]);
    expect(keyField()).toBeNull();
    expect(labels).not.toContain("Or paste an API key");
    expect(button("Disconnect").disabled).toBe(false);
    expect(container.textContent).toContain("linked voice");
  },
);

it("still connects a typed key from behind the model connection choices", async () => {
  state.load.mockResolvedValue(false);
  withLinkedProvider(null);
  await render();
  await click("Linked");
  await click("Or paste an API key");
  expect(keyField()?.placeholder).toBe("Paste your API key");
  // An empty key no longer stands in for the model connection.
  expect(button("Connect").disabled).toBe(true);
  await typeInto("API key", "short");
  expect(button("Connect").disabled).toBe(true);
  await typeInto("API key", "a-whole-key");
  await click("Connect");
  const [, sent] = state.rpc.mock.calls.find(([proc]) => proc === "voice/connect")!;
  expect(sent).toMatchObject({ provider: "linked", scope: "account", apiKey: "a-whole-key" });
  expect(sent.modelCredentialId).toBeUndefined();
  expect(keyField()?.placeholder).toBe("Paste a replacement key");
  expect(button("Replace key")).toBeDefined();
});

it("signs in through the Models connection screen, then connects voice through the saved connection", async () => {
  state.load.mockResolvedValue(false);
  const entry: { modelConnections?: { id: string; label: string }[]; modelSignIn?: string } = {
    modelSignIn: "Sign in with a plan",
  };
  withLinkedProvider(null, entry);
  await render();
  await click("Linked");
  expect(keyField()).toBeNull();
  expect(button("Or paste an API key")).toBeDefined();
  await click("Sign in with a plan");
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/model-connection",
    params: { requestId: expect.any(String) },
  });
  const [{ params }] = state.push.mock.calls[0] as [{ params: { requestId: string } }];
  const request = modelConnectionRequest(params.requestId)!;
  expect(request).toMatchObject({
    provider: "linked",
    credentialId: null,
    makeDefault: false,
    target: { scope: "account" },
  });
  expect(state.rpc).not.toHaveBeenCalledWith("voice/connect", expect.anything());

  // The sign-in saved a Models connection, which the catalog now lists.
  entry.modelConnections = [{ id: "signed-in-connection", label: "Signed in" }];
  await act(async () => request.onSaved!("signed-in-connection"));
  expect(state.rpc).toHaveBeenCalledWith("voice/connect", {
    provider: "linked",
    scope: "account",
    apiKey: "",
    modelCredentialId: "signed-in-connection",
  });
  expectOnlyDisconnect();
});

it("opens one sign-in screen for a double tap and keeps its request", async () => {
  state.load.mockResolvedValue(false);
  withLinkedProvider(null, { modelSignIn: "Sign in with a plan" });
  await render();
  await click("Linked");
  await click("Sign in with a plan");
  await click("Sign in with a plan");
  expect(state.push).toHaveBeenCalledOnce();
  const [{ params }] = state.push.mock.calls[0] as [{ params: { requestId: string } }];
  expect(modelConnectionRequest(params.requestId)).toMatchObject({ provider: "linked" });
});

it("offers the new connection, not another sign-in, when voice cannot connect through it", async () => {
  state.load.mockResolvedValue(false);
  withLinkedProvider(null, { modelSignIn: "Sign in with a plan" });
  await render();
  await click("Linked");
  await click("Sign in with a plan");
  const [{ params }] = state.push.mock.calls[0] as [{ params: { requestId: string } }];
  const request = modelConnectionRequest(params.requestId)!;
  // The sign-in saved a Models connection, which the next catalog read lists; voice refuses it.
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc, args) => {
    if (proc === "voice/connect") throw new Error("The provider is unavailable.");
    if (proc === "voice/catalog")
      return [
        ...catalog,
        { id: "linked", name: "Linked", transcribe: true, modelConnections: [personalPlan] },
      ];
    return original(proc, args);
  });

  await act(async () => request.onSaved!("signed-in-connection"));

  expect(container.textContent).toContain("The provider is unavailable.");
  expect(button("Use Personal plan")).toBeDefined();
  expect(
    [...container.querySelectorAll("button")].some(
      (item) => item.textContent === "Sign in with a plan",
    ),
  ).toBe(false);
});

it("moves a working link to another of the account's subscriptions", async () => {
  state.load.mockResolvedValue(false);
  withLinkedProvider({ hasKey: false, modelCredentialId: personalPlan.id } as { hasKey: boolean }, {
    modelConnections: [personalPlan, workPlan],
  });
  await render();
  await click("Linked");
  expect(container.textContent).not.toContain(`Use ${personalPlan.label}`);
  expect(container.textContent).not.toContain("Or paste an API key");
  await click(`Use ${workPlan.label}`);
  expect(state.rpc).toHaveBeenCalledWith("voice/connect", {
    provider: "linked",
    scope: "account",
    apiKey: "",
    modelCredentialId: workPlan.id,
  });
});

it("links voice again once the model connection it used is gone", async () => {
  state.load.mockResolvedValue(false);
  withLinkedProvider({ hasKey: false, modelCredentialId: "gone" } as { hasKey: boolean });
  await render();
  await click("Linked");
  await click("Use Personal plan");
  expect(state.rpc).toHaveBeenCalledWith("voice/connect", {
    provider: "linked",
    scope: "account",
    apiKey: "",
    modelCredentialId: personalPlan.id,
  });
  expectOnlyDisconnect();
});

it("still needs a whole key to replace a key saved for a model-connection provider", async () => {
  state.load.mockResolvedValue(false);
  withLinkedProvider({ hasKey: true });
  await render();
  await click("Linked");
  expect(keyField()?.placeholder).toBe("Paste a replacement key");
  expect(container.textContent).not.toContain("Use Personal plan");
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
  await click("Use Personal plan");
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
  await click("Use Personal plan");
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
  await click("Use Personal plan");
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
