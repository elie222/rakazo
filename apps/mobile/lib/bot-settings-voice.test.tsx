// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BotSettingsScreen from "../app/bot-settings";
import { MenuPicker } from "../components/menu-picker";

const mocks = vi.hoisted(() => ({
  deviceVoices: vi.fn(),
  voiceForBot: vi.fn(),
  setVoiceForBot: vi.fn(),
  stopVoicePlayback: vi.fn(),
  stop: vi.fn(),
  speak: vi.fn(),
}));
const offered = [
  { identifier: "voice-a", name: "Alice", language: "en-US" },
  { identifier: "voice-b", name: "Beth", language: "en-GB" },
];

function deferredSave() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((resolveSave, rejectSave) => {
    resolve = resolveSave;
    reject = rejectSave;
  });
  return { promise, resolve, reject };
}

vi.mock("./bot-voices", () => ({
  voiceLabel: (voice: { language: string; name: string }) => `${voice.language} · ${voice.name}`,
  deviceVoices: mocks.deviceVoices,
  voiceForBot: mocks.voiceForBot,
  setVoiceForBot: mocks.setVoiceForBot,
}));
vi.mock("./device-voice", () => ({ loadDeviceVoiceEnabled: async () => true }));
vi.mock("./voice", () => ({ stopVoicePlayback: mocks.stopVoicePlayback }));
vi.mock("expo-speech", () => ({ stop: mocks.stop, speak: mocks.speak }));
vi.mock("./api", () => ({
  rpc: async (procedure: string) => {
    if (procedure === "bots/get")
      return { id: "bot-fixture", name: "Fixture", title: "", computerMode: "team" };
    if (procedure === "me") return {};
    return [];
  },
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back: vi.fn() }),
  useLocalSearchParams: () => ({ botId: "bot-fixture" }),
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => {
  const view = ({
    children,
    style,
    accessibilityLabel,
    accessibilityRole,
    accessibilityValue,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityValue?: { text: string };
  }) =>
    createElement(
      "div",
      {
        "data-style": JSON.stringify(style),
        "aria-label": accessibilityLabel,
        role: accessibilityRole,
        "aria-valuetext": accessibilityValue?.text,
      },
      children,
    );
  return {
    Platform: { OS: "ios" },
    StyleSheet: { create: (styles: unknown) => styles },
    ScrollView: view,
    View: view,
    Text: ({ children, style }: { children?: ReactNode; style: unknown }) =>
      createElement("span", { "data-style": JSON.stringify(style) }, children),
    TextInput: () => null,
    Pressable: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) =>
      createElement("button", { type: "button", onClick: onPress }, children),
  };
});
vi.mock("./native", () => ({
  native: { tertiaryLabel: "muted" },
  useMobileTokens: () => ({ mutedForeground: "muted", foreground: "ink", destructive: "error" }),
  useResolvedAppearance: () => "light",
  useThemedStyles: (createStyles: () => unknown) => createStyles(),
}));
vi.mock("./i18n", () => {
  const t = (text: string, values?: { name: string }) => text.replace("{name}", values?.name ?? "");
  return { useI18n: () => ({ t }) };
});
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/computer-mode-picker", () => ({ ComputerModePicker: () => null }));
vi.mock("../components/native-action-button", () => ({ NativeActionButton: () => null }));
vi.mock("../components/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("../components/row-accessories", () => ({ Chevron: () => null }));
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios, android }: { ios: string; android: string }) =>
    createElement("i", { "data-ios": ios, "data-android": android }),
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    title,
    actions,
    onPressAction,
    children,
  }: {
    title: string;
    actions: { id: string; title: string; state: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children: ReactNode;
  }) =>
    createElement(
      "section",
      { "data-menu": title },
      children,
      ...actions.map((action) =>
        createElement(
          "button",
          {
            type: "button",
            key: action.id,
            "data-state": action.state,
            onClick: () => onPressAction({ nativeEvent: { event: action.id } }),
          },
          action.title,
        ),
      ),
    ),
}));

describe("bot settings device voice menu", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.deviceVoices.mockResolvedValue(offered);
    mocks.voiceForBot.mockResolvedValue("voice-a");
    mocks.setVoiceForBot.mockResolvedValue(undefined);
    mocks.stop.mockResolvedValue(undefined);
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });
  const render = async () => act(async () => root.render(<BotSettingsScreen />));
  const menu = () => container.querySelector('[data-menu="Device voice"]');

  it("marks the current voice, keeps the plain row, and saves before playing a sample", async () => {
    await render();
    const actions = menu()!.querySelectorAll("button");
    expect([...actions].map((action) => [action.textContent, action.dataset.state])).toEqual([
      ["en-US · Alice", "on"],
      ["en-GB · Beth", "off"],
    ]);
    const labels = [...container.querySelectorAll("span")];
    const label = (text: string) => labels.find((item) => item.textContent === text)!;
    expect(label("Device voice").dataset.style).toBe(label("Read replies aloud").dataset.style);
    const row = label("Device voice").parentElement!;
    expect(row.lastElementChild).toBe(menu());
    expect(JSON.parse(row.dataset.style!)).toEqual(
      JSON.parse(label("Read replies aloud").parentElement!.dataset.style!)[0],
    );
    expect(menu()!.contains(label("Device voice"))).toBe(false);
    const trigger = menu()!.firstElementChild!;
    expect(trigger.getAttribute("role")).toBe("button");
    expect(trigger.getAttribute("aria-label")).toBe("Device voice");
    expect(trigger.getAttribute("aria-valuetext")).toBe("en-US · Alice");
    expect(label("en-US · Alice").dataset.style).toContain('"textAlign":"right"');
    expect(menu()!.querySelector("i")!.dataset).toMatchObject({
      ios: "chevron.up.chevron.down",
      android: "chevron-expand",
    });
    await act(async () => actions[1]!.click());
    expect(mocks.setVoiceForBot).toHaveBeenCalledWith("bot-fixture", "voice-b");
    expect(mocks.stopVoicePlayback).toHaveBeenCalledOnce();
    expect(mocks.speak).toHaveBeenCalledWith("Hi, I'm Fixture.", { voice: "voice-b" });
    expect(mocks.setVoiceForBot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.speak.mock.invocationCallOrder[0]!,
    );
    expect([...menu()!.querySelectorAll("button")].map((action) => action.dataset.state)).toEqual([
      "off",
      "on",
    ]);
  });

  it("restores the checkmark and skips the sample when saving fails", async () => {
    mocks.setVoiceForBot.mockRejectedValueOnce(new Error("Save failed"));
    await render();
    await act(async () => menu()!.querySelectorAll("button")[1]!.click());
    expect(menu()!.querySelector("button")!.dataset.state).toBe("on");
    expect(container.textContent).toContain("Could not save that voice");
    expect(mocks.speak).not.toHaveBeenCalled();
  });

  it.each([
    { firstSucceeds: false, latestSucceeds: true },
    { firstSucceeds: false, latestSucceeds: false },
    { firstSucceeds: true, latestSucceeds: false },
    { firstSucceeds: true, latestSucceeds: true },
  ])(
    "keeps overlapping choices consistent (first saves: $firstSucceeds, latest saves: $latestSucceeds)",
    async ({ firstSucceeds, latestSucceeds }) => {
      mocks.deviceVoices.mockResolvedValue([
        ...offered,
        { identifier: "voice-c", name: "Clara", language: "en-US" },
      ]);
      const first = deferredSave();
      const latest = deferredSave();
      mocks.setVoiceForBot.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
      await render();
      const actions = () => [...menu()!.querySelectorAll("button")];
      await act(async () => actions()[1]!.click());
      await act(async () => actions()[2]!.click());
      expect(mocks.setVoiceForBot.mock.calls).toEqual([
        ["bot-fixture", "voice-b"],
        ["bot-fixture", "voice-c"],
      ]);

      await act(async () => {
        if (firstSucceeds) first.resolve();
        else first.reject(new Error("First save failed"));
      });
      expect(actions().map((action) => action.dataset.state)).toEqual(["off", "off", "on"]);
      expect(container.textContent).not.toContain("Could not save that voice");
      expect(mocks.speak).not.toHaveBeenCalled();

      await act(async () => {
        if (latestSucceeds) latest.resolve();
        else latest.reject(new Error("Latest save failed"));
      });
      const savedIndex = latestSucceeds ? 2 : firstSucceeds ? 1 : 0;
      expect(actions().map((action) => action.dataset.state)).toEqual(
        [0, 1, 2].map((index) => (index === savedIndex ? "on" : "off")),
      );
      if (latestSucceeds) {
        expect(container.textContent).not.toContain("Could not save that voice");
        expect(mocks.speak).toHaveBeenCalledExactlyOnceWith("Hi, I'm Fixture.", {
          voice: "voice-c",
        });
      } else {
        expect(container.textContent).toContain("Could not save that voice");
        expect(mocks.speak).not.toHaveBeenCalled();
      }
    },
  );

  it.each([{ voices: [] }, { voices: offered.slice(0, 1) }])(
    "shows a plain row without a menu for $voices.length voices",
    async ({ voices }) => {
      mocks.deviceVoices.mockResolvedValue(voices);
      await render();
      expect(menu()).toBeNull();
      const label = [...container.querySelectorAll("span")].find(
        (item) => item.textContent === "Device voice",
      )!;
      expect(label.parentElement!.lastElementChild!.tagName).toBe("SPAN");
      expect(label.parentElement!.lastElementChild!.getAttribute("data-style")).toContain(
        '"textAlign":"right"',
      );
      expect(container.querySelector("i")).toBeNull();
    },
  );

  it("keeps a destructive retry row after failure and replaces it with a menu on success", async () => {
    mocks.deviceVoices.mockRejectedValueOnce(new Error("Load failed"));
    await render();
    expect(menu()).toBeNull();
    expect(container.querySelector("i")).toBeNull();
    const retry = () =>
      [...container.querySelectorAll("button")].find((item) =>
        item.textContent?.includes("Could not load voices"),
      )!;
    expect(retry().querySelectorAll("span")[1]!.dataset.style).toContain('"color":"error"');
    mocks.deviceVoices.mockRejectedValueOnce(new Error("Still unavailable"));
    await act(async () => retry().click());
    expect(menu()).toBeNull();
    await act(async () => retry().click());
    expect(menu()).not.toBeNull();
    expect(container.textContent).not.toContain("Could not load voices");
    expect(mocks.speak).not.toHaveBeenCalled();
  });

  it("preserves Model/Thinking menus and their empty default choice", async () => {
    const onChange = vi.fn();
    const props: ComponentProps<typeof MenuPicker> = {
      label: "Model",
      choices: [
        { key: "", label: "Default" },
        { key: "model-a", label: "Model A" },
      ],
      value: "model-a",
      onChange,
    };
    await act(async () => root.render(<MenuPicker {...props} />));
    const actions = container.querySelectorAll("button");
    expect(actions[1]!.dataset.state).toBe("on");
    await act(async () => actions[0]!.click());
    expect(onChange).toHaveBeenCalledWith("");
    expect(container.querySelector("i")!.dataset.ios).toBe("chevron.up.chevron.down");
  });
});
