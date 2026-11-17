// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotVoiceSettings } from "../components/bot-voice-settings";
import { queryClient, rpcQuery } from "./query";

const state = vi.hoisted(() => ({
  bot: {
    id: "bot-a",
    name: "Helper",
    voiceProvider: null as string | null,
    voiceId: null as string | null,
  },
  defaultProvider: "provider-a",
  save: vi.fn(),
  speak: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://api.example.test",
  selectedSpaceId: () => "space-a",
  captureApiRequestContext: async () => ({
    apiBase: "https://api.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-a" },
  }),
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
        { provider: "provider-a", voiceId: "a-default" },
        { provider: "provider-b", voiceId: "b-default" },
      ];
    if (proc === "voice/voices")
      return [
        {
          id: input?.provider === "provider-b" ? "b-default" : "a-default",
          label: "Settings voice",
        },
        { id: "custom", label: "Custom voice" },
      ];
    if (proc === "voice/status") {
      const provider = input?.botId
        ? (state.bot.voiceProvider ?? state.defaultProvider)
        : state.defaultProvider;
      return {
        ready: true,
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
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./app-foreground", () => ({ useAppForeground: () => true }));
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
vi.mock("../components/native-action-button", () => ({
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
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children, footer }: { children: ReactNode; footer?: string }) => (
    <section>
      {children}
      {footer}
    </section>
  ),
}));
vi.mock("../components/menu-picker", () => ({
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
  state.save.mockResolvedValue(undefined);
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
  await act(async () => {
    queryClient.setQueryData(rpcQuery("voice/status").queryKey, {
      ready: true,
      configured: true,
      transcribe: false,
      provider: "provider-b",
      voiceId: "b-default",
    });
  });
  expect(container.textContent).toContain("Default (Provider B)");
  expect(state.bot.voiceProvider).toBeNull();
  expect(state.save).not.toHaveBeenCalled();
});

it("plays only an explicit sample with the saved effective provider and voice, and stops on leave", async () => {
  state.bot.voiceProvider = "provider-b";
  state.bot.voiceId = "custom";
  const playing = deferred<boolean>();
  state.speak.mockReturnValueOnce(playing.promise);
  await open();
  expect(state.speak).not.toHaveBeenCalled();
  await act(async () => button("Hear a sample").click());
  expect(state.speak).toHaveBeenCalledWith(expect.any(String), {
    botId: "bot-a",
    provider: "provider-b",
    voiceId: "custom",
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
