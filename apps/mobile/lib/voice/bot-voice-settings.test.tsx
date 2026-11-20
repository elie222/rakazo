// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotVoiceSettings } from "../../components/bots/bot-voice-settings";
import type { ApiRequestContext } from "../api/api";
import { queryClient, rpcQuery } from "../query/query";

const state = vi.hoisted(() => ({
  bot: {
    id: "bot-a",
    name: "Helper",
    voiceProvider: null as string | null,
    voiceId: null as string | null,
  },
  defaultProvider: "provider-a",
  connected: ["provider-a", "provider-b"],
  ready: true,
  spaceId: "space-a",
  capture: vi.fn(),
  save: vi.fn(),
  status: vi.fn(),
  speak: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("../api/api", () => ({
  currentApiBase: () => "https://api.example.test",
  selectedSpaceId: () => state.spaceId,
  captureApiRequestContext: state.capture,
  rpc: async (
    proc: string,
    input?: {
      provider?: string;
      botId?: string;
      voiceProvider?: string | null;
      voiceId?: string | null;
    },
  ) => {
    if (proc === "bots/get") return { ...state.bot };
    if (proc === "voice/catalog")
      return [
        { id: "provider-a", name: "Provider A" },
        { id: "provider-b", name: "Provider B" },
        { id: "unconnected", name: "Unconnected" },
      ];
    if (proc === "voice/credentials")
      return [
        {
          provider: "provider-a",
          voiceId: "a-default",
          isDefault: state.defaultProvider === "provider-a",
        },
        {
          provider: "provider-b",
          voiceId: "b-default",
          isDefault: state.defaultProvider === "provider-b",
        },
      ].filter((credential) => state.connected.includes(credential.provider));
    if (proc === "voice/voices")
      return [
        {
          id: input?.provider === "provider-b" ? "b-default" : "a-default",
          label: "Settings voice",
        },
        { id: "custom", label: "Custom voice" },
      ];
    if (proc === "voice/status") {
      await state.status(input);
      const provider = input?.botId
        ? (state.bot.voiceProvider ?? state.defaultProvider)
        : state.defaultProvider;
      return {
        ready: state.ready,
        provider,
        voiceId:
          input?.botId && state.bot.voiceId
            ? state.bot.voiceId
            : provider === "provider-b"
              ? "b-default"
              : "a-default",
      };
    }
    if (proc === "bots/update") {
      await state.save(input);
      state.bot = { ...state.bot, ...input };
      return { ...state.bot };
    }
    throw new Error(`Unexpected procedure: ${proc}`);
  },
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => void) => useEffect(callback, [callback]),
}));
vi.mock("./voice", () => ({
  createSpeechOwner: () => Symbol("sample"),
  speakText: state.speak,
  stopSpeaking: state.stop,
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({
    accessibilityLabel,
    disabled,
    onPress,
  }: {
    accessibilityLabel: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button type="button" aria-label={accessibilityLabel} disabled={disabled} onClick={onPress} />
  ),
}));
vi.mock("../../components/settings/settings-group", () => ({
  SettingsRow: ({ title, value }: { title: string; value: string }) => (
    <fieldset aria-label={title}>{value}</fieldset>
  ),
  SettingsGroup: ({ children, footer }: { children: ReactNode; footer?: string }) => (
    <section>
      {children}
      {footer}
    </section>
  ),
}));
vi.mock("../../components/ui/menu-picker", () => ({
  MenuPicker: ({
    label,
    choices,
    value,
    disabled,
    onChange,
  }: {
    label: string;
    choices: { key: string; label: string }[];
    value: string;
    disabled: boolean;
    onChange: (value: string) => void;
  }) => (
    <fieldset aria-label={label}>
      {choices.map((choice) => (
        <button
          type="button"
          key={choice.key}
          disabled={disabled}
          aria-pressed={value === choice.key}
          onClick={() => onChange(choice.key)}
        >
          {choice.label}
        </button>
      ))}
    </fieldset>
  ),
}));
notifyManager.setScheduler((callback) => callback());
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  queryClient.clear();
  state.bot = { id: "bot-a", name: "Helper", voiceProvider: null, voiceId: null };
  state.defaultProvider = "provider-a";
  state.connected = ["provider-a", "provider-b"];
  state.ready = true;
  state.spaceId = "space-a";
  state.capture.mockImplementation(async () => ({
    apiBase: "https://api.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": state.spaceId },
  }));
  state.save.mockResolvedValue(undefined);
  state.status.mockResolvedValue(undefined);
  state.speak.mockResolvedValue(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
});
async function open() {
  await act(async () => root.render(<BotVoiceSettings botId="bot-a" />));
  await act(async () => {
    await vi.waitFor(() => expect(button("Provider A").disabled).toBe(false));
  });
}
function button(text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === text || entry.getAttribute("aria-label") === text,
  );
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
}

it("offers connected catalog labels and clears voice when the provider changes", async () => {
  state.bot.voiceId = "custom";
  await open();
  expect(container.textContent).not.toContain("Unconnected");
  const gate = deferred();
  state.save.mockReturnValueOnce(gate.promise);
  await act(async () => button("Provider B").click());
  await vi.waitFor(() =>
    expect(state.save).toHaveBeenCalledWith({
      botId: "bot-a",
      voiceProvider: "provider-b",
      voiceId: null,
    }),
  );
  expect(button("Hear a sample").disabled).toBe(true);
  expect(state.speak).not.toHaveBeenCalled();
  await act(async () => gate.resolve());
  await act(async () => {
    await vi.waitFor(() => expect(button("Provider B").getAttribute("aria-pressed")).toBe("true"));
  });
  expect(state.bot.voiceId).toBeNull();
});

it("keeps inherited choices null while Settings defaults update live", async () => {
  await open();
  expect(container.textContent).toContain("Default (Provider A)");
  state.defaultProvider = "provider-b";
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: rpcQuery("voice/credentials").queryKey });
  });
  expect(container.textContent).toContain("Default (Provider B)");
  expect(state.bot.voiceProvider).toBeNull();
  expect(state.save).not.toHaveBeenCalled();
});

it("lets the server resolve fresh saved defaults instead of overriding with cached status", async () => {
  await open();
  const statusKey = rpcQuery("voice/status", { botId: "bot-a" }).queryKey;
  expect(queryClient.getQueryData(statusKey)).toMatchObject({
    provider: "provider-a",
    voiceId: "a-default",
  });
  state.defaultProvider = "provider-b";
  state.status.mockClear();
  await act(async () => button("Hear a sample").click());
  expect(state.status).not.toHaveBeenCalled();
  expect(state.speak).toHaveBeenCalledWith(expect.any(String), {
    botId: "bot-a",
    hostedPreview: true,
    requestContext: {
      apiBase: "https://api.example.test",
      sessionGeneration: 1,
      headers: { "x-rakazo-space-id": "space-a" },
    },
    owner: expect.any(Symbol),
  });
  expect(queryClient.getQueryData(statusKey)).toMatchObject({
    provider: "provider-a",
    voiceId: "a-default",
  });
  expect(state.save).not.toHaveBeenCalled();
});

it("previews the saved bot without overrides and stops on leave", async () => {
  state.bot.voiceProvider = "provider-b";
  state.bot.voiceId = "custom";
  const playing = deferred<boolean>();
  state.speak.mockReturnValueOnce(playing.promise);
  await open();
  expect(state.speak).not.toHaveBeenCalled();
  await act(async () => button("Hear a sample").click());
  expect(state.speak).toHaveBeenCalledWith(expect.any(String), {
    botId: "bot-a",
    hostedPreview: true,
    requestContext: expect.objectContaining({
      headers: { "x-rakazo-space-id": "space-a" },
    }),
    owner: expect.any(Symbol),
  });
  const owner = state.speak.mock.calls[0]?.[1].owner;
  await act(async () => button("Stop").click());
  expect(state.stop).toHaveBeenCalledWith(owner);
  await act(async () => playing.resolve(false));
  expect(container.textContent).not.toContain("Could not play that sample.");
  await act(async () => root.render(null));
  expect(state.stop).toHaveBeenCalledWith(owner);
});

it.each(["stop", "leave"])(
  "does not start a late sample after %s during context capture",
  async (action) => {
    await open();
    const capture = deferred<ApiRequestContext>();
    state.capture.mockResolvedValueOnce({
      apiBase: "https://api.example.test",
      sessionGeneration: 1,
      headers: { "x-rakazo-space-id": "space-a" },
    });
    state.capture.mockReturnValueOnce(capture.promise);
    await act(async () => button("Hear a sample").click());
    expect(state.speak).not.toHaveBeenCalled();
    if (action === "stop") {
      await act(async () => button("Stop").click());
    } else {
      await act(async () => root.render(null));
    }
    expect(state.stop).toHaveBeenCalledWith(expect.any(Symbol));
    await act(async () =>
      capture.resolve({
        apiBase: "https://api.example.test",
        sessionGeneration: 1,
        headers: { "x-rakazo-space-id": "space-a" },
      }),
    );
    expect(state.speak).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Could not play that sample.");
  },
);

it("reports a sample that fails to play", async () => {
  await open();
  state.speak.mockResolvedValueOnce(false);
  await act(async () => button("Hear a sample").click());
  expect(container.textContent).toContain("Could not play that sample.");
  expect(button("Hear a sample").disabled).toBe(false);
});

it("reports a failed preview context capture without starting a sample", async () => {
  await open();
  state.capture.mockRejectedValue(new Error("Could not check voice"));
  await act(async () => button("Hear a sample").click());
  expect(state.speak).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Could not check voice");
  expect(button("Hear a sample").disabled).toBe(false);
});

it("pins a custom voice chosen under Default and resumes inheritance when reset", async () => {
  await open();
  await act(async () => button("Custom voice").click());
  await act(async () => {
    await vi.waitFor(() => expect(button("Provider A").getAttribute("aria-pressed")).toBe("true"));
  });
  expect(state.bot.voiceProvider).toBe("provider-a");
  expect(state.bot.voiceId).toBe("custom");
  state.defaultProvider = "provider-b";
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: rpcQuery("voice/credentials").queryKey });
    await queryClient.invalidateQueries({
      queryKey: rpcQuery("voice/status", { botId: "bot-a" }).queryKey,
    });
  });
  expect(button("Provider A").getAttribute("aria-pressed")).toBe("true");
  expect(button("Custom voice").getAttribute("aria-pressed")).toBe("true");
  expect(queryClient.getQueryData(rpcQuery("bots/get", { botId: "bot-a" }).queryKey)).toMatchObject(
    {
      voiceProvider: "provider-a",
      voiceId: "custom",
    },
  );
  await act(async () => button("Hear a sample").click());
  expect(state.speak).toHaveBeenLastCalledWith(expect.any(String), {
    botId: "bot-a",
    hostedPreview: true,
    requestContext: expect.objectContaining({
      headers: { "x-rakazo-space-id": "space-a" },
    }),
    owner: expect.any(Symbol),
  });
  await act(async () => button("Default (Provider B)").click());
  await act(async () => {
    await vi.waitFor(() =>
      expect(button("Default (Provider B)").getAttribute("aria-pressed")).toBe("true"),
    );
  });
  expect(state.bot.voiceProvider).toBeNull();
  expect(state.bot.voiceId).toBeNull();
  expect(button("Default (Settings voice)").getAttribute("aria-pressed")).toBe("true");
  state.defaultProvider = "provider-a";
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: rpcQuery("voice/credentials").queryKey });
  });
  expect(button("Default (Provider A)").getAttribute("aria-pressed")).toBe("true");
});

it("keeps a pinned provider when clearing only its voice", async () => {
  state.bot.voiceProvider = "provider-b";
  state.bot.voiceId = "custom";
  await open();
  await act(async () => button("Default (Settings voice)").click());
  await act(async () => {
    await vi.waitFor(() =>
      expect(button("Default (Settings voice)").getAttribute("aria-pressed")).toBe("true"),
    );
  });
  expect(state.bot.voiceProvider).toBe("provider-b");
  expect(state.bot.voiceId).toBeNull();
  expect(button("Provider B").getAttribute("aria-pressed")).toBe("true");
});

it("does not pin Settings when clearing a legacy inherited voice", async () => {
  state.bot.voiceId = "custom";
  await open();
  await act(async () => button("Default (Settings voice)").click());
  await act(async () => {
    await vi.waitFor(() =>
      expect(button("Default (Settings voice)").getAttribute("aria-pressed")).toBe("true"),
    );
  });
  expect(state.bot.voiceProvider).toBeNull();
  expect(state.bot.voiceId).toBeNull();
  expect(button("Default (Provider A)").getAttribute("aria-pressed")).toBe("true");
});

it("keeps the accepted provider and voice when a new selection fails to save", async () => {
  state.bot.voiceProvider = "provider-b";
  state.bot.voiceId = "custom";
  const gate = deferred();
  state.save.mockReturnValueOnce(gate.promise);
  await open();
  await act(async () => button("Settings voice").click());
  expect(button("Hear a sample").disabled).toBe(true);
  await act(async () => gate.reject(new Error("Could not save voice")));
  await act(async () => {
    await vi.waitFor(() => expect(button("Hear a sample").disabled).toBe(false));
  });
  expect(container.textContent).toContain("Could not save voice");
  expect(button("Provider B").getAttribute("aria-pressed")).toBe("true");
  expect(button("Custom voice").getAttribute("aria-pressed")).toBe("true");
  expect(queryClient.getQueryData(rpcQuery("bots/get", { botId: "bot-a" }).queryKey)).toMatchObject(
    {
      voiceProvider: "provider-b",
      voiceId: "custom",
    },
  );
  await act(async () => button("Hear a sample").click());
  expect(state.speak).toHaveBeenCalledWith(expect.any(String), {
    botId: "bot-a",
    hostedPreview: true,
    requestContext: expect.objectContaining({
      headers: { "x-rakazo-space-id": "space-a" },
    }),
    owner: expect.any(Symbol),
  });
});

it("shows included-ready speech as read-only defaults with an adjacent sample", async () => {
  state.connected = [];
  await act(async () => root.render(<BotVoiceSettings botId="bot-a" />));
  await act(async () => {
    await vi.waitFor(() => expect(button("Hear a sample").disabled).toBe(false));
  });
  expect(container.querySelectorAll("button[aria-pressed]")).toHaveLength(0);
  expect(container.querySelector('[aria-label="Provider"]')?.textContent).toBe("Default");
  expect(container.querySelector('[aria-label="Voice"]')?.textContent).toBe("Default");
  await act(async () => button("Hear a sample").click());
  expect(state.speak).toHaveBeenCalledWith(expect.any(String), {
    botId: "bot-a",
    hostedPreview: true,
    requestContext: expect.objectContaining({
      headers: { "x-rakazo-space-id": "space-a" },
    }),
    owner: expect.any(Symbol),
  });
  expect(state.save).not.toHaveBeenCalled();
});

it("keeps owned providers selectable when the inherited voice is included", async () => {
  state.defaultProvider = "included-provider";
  await open();
  expect(container.querySelector('[aria-label="Voice"]')?.textContent).toBe("Default");
  expect(button("Provider B").disabled).toBe(false);
  await act(async () => button("Provider B").click());
  expect(state.save).toHaveBeenCalledWith({
    botId: "bot-a",
    voiceProvider: "provider-b",
    voiceId: null,
  });
});

it("does not start a sample after the Space changes during context capture", async () => {
  await open();
  const context = {
    apiBase: "https://api.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-a" },
  };
  const capture = deferred<typeof context>();
  state.capture.mockResolvedValueOnce(context).mockReturnValueOnce(capture.promise);
  await act(async () => button("Hear a sample").click());
  state.spaceId = "space-b";
  await act(async () => root.render(<BotVoiceSettings botId="bot-a" />));
  await act(async () => capture.resolve(context));
  expect(state.speak).not.toHaveBeenCalled();
});

it("keeps the preview pinned and hides its late error after the Space changes", async () => {
  await open();
  const playing = deferred<boolean>();
  state.speak.mockReturnValueOnce(playing.promise);
  await act(async () => button("Hear a sample").click());
  expect(button("Stop").disabled).toBe(false);
  state.spaceId = "space-b";
  await act(async () => root.render(<BotVoiceSettings botId="bot-a" />));
  expect(state.speak.mock.calls[0]?.[1].requestContext.headers).toEqual({
    "x-rakazo-space-id": "space-a",
  });
  await act(async () => playing.reject(new Error("Old sample failed")));
  expect(container.textContent).not.toContain("Old sample failed");
});

it("omits unavailable voice controls before any connection is configured", async () => {
  state.connected = [];
  state.ready = false;
  await act(async () => root.render(<BotVoiceSettings botId="bot-a" />));
  await act(async () => {
    await vi.waitFor(() =>
      expect(queryClient.getQueryState(rpcQuery("voice/credentials").queryKey)?.status).toBe(
        "success",
      ),
    );
  });
  expect(container.textContent).toBe("");
  expect(container.querySelector("button")).toBeNull();
});

it("explains a disconnected saved provider instead of offering a stale ready preview", async () => {
  state.bot.voiceProvider = "provider-b";
  state.connected = ["provider-a"];
  await open();
  expect(container.textContent).toContain("Reconnect this provider in Settings → Voice.");
  expect(button("Hear a sample").disabled).toBe(true);
});

it("labels unavailable saved choices without displaying their IDs", async () => {
  state.bot.voiceProvider = "missing-provider";
  state.bot.voiceId = "missing-voice";
  await open();
  const unavailable = [...container.querySelectorAll("button")].filter(
    (entry) => entry.textContent === "Unavailable",
  );
  expect(unavailable).toHaveLength(2);
  for (const choice of unavailable) expect(choice.getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).not.toContain("missing-provider");
  expect(container.textContent).not.toContain("missing-voice");
});

it("keeps an unknown default voice out of the Default label", async () => {
  await open();
  await act(async () => {
    queryClient.setQueryData(rpcQuery("voice/credentials").queryKey, (current) =>
      current?.map((credential) =>
        credential.provider === "provider-a"
          ? { ...credential, voiceId: "missing-default" }
          : credential,
      ),
    );
  });
  expect(button("Default").getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).not.toContain("missing-default");
  expect(container.textContent).not.toContain("Default (Unavailable)");
});
