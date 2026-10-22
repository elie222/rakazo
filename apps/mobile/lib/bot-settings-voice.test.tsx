// @vitest-environment jsdom

import { BOT_COLORS, BOT_SETTINGS_ADVANCED_ORDER } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BotSettingsScreen from "../app/bot-settings";
import { MenuPicker } from "../components/menu-picker";

const mocks = vi.hoisted(() => ({
  fill: "light-fill",
  deviceVoices: vi.fn(),
  voiceForBot: vi.fn(),
  setVoiceForBot: vi.fn(),
  rpc: vi.fn(),
  back: vi.fn(),
  stopVoicePlayback: vi.fn(),
  stop: vi.fn(),
  speak: vi.fn(),
  alert: vi.fn(),
  layouts: new WeakMap<
    HTMLElement,
    (event: { nativeEvent: { layout: { width: number } } }) => void
  >(),
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
  rpc: async (procedure: string, input?: unknown) => {
    if (procedure === "bots/update" || procedure === "bots/setComputer")
      return mocks.rpc(procedure, input);
    if (procedure === "bots/get")
      return {
        id: "bot-fixture",
        name: "Fixture",
        title: "",
        instructions: "",
        color: BOT_COLORS[0],
        autoSpeak: false,
        computerMode: "team",
        fleetManagement: false,
      };
    if (procedure === "me") return {};
    return [];
  },
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back: mocks.back }),
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
    onLayout,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityValue?: { text: string };
    onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
  }) =>
    createElement(
      "div",
      {
        "data-style": JSON.stringify(style),
        "aria-label": accessibilityLabel,
        role: accessibilityRole,
        "aria-valuetext": accessibilityValue?.text,
        ref: (element: HTMLElement | null) => {
          if (element && onLayout) mocks.layouts.set(element, onLayout);
        },
      },
      children,
    );
  return {
    Alert: { alert: mocks.alert },
    Platform: { OS: "ios" },
    StyleSheet: { create: (styles: unknown) => styles },
    ScrollView: view,
    View: view,
    Text: ({ children, style }: { children?: ReactNode; style: unknown }) =>
      createElement("span", { "data-style": JSON.stringify(style) }, children),
    TextInput: ({
      style,
      accessibilityLabel,
      placeholder,
      multiline,
    }: {
      style?: unknown;
      accessibilityLabel?: string;
      placeholder?: string;
      multiline?: boolean;
    }) =>
      createElement("textarea", {
        "data-style": JSON.stringify(style),
        "aria-label": accessibilityLabel,
        "aria-multiline": multiline,
        placeholder,
      }),
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessibilityHint,
      accessibilityRole,
    }: {
      children?: ReactNode;
      onPress: () => void;
      accessibilityLabel?: string;
      accessibilityHint?: string;
      accessibilityRole?: string;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          "aria-label": accessibilityLabel,
          "data-hint": accessibilityHint,
          role: accessibilityRole,
        },
        children,
      ),
  };
});
vi.mock("./native", () => ({
  native: {
    tertiaryLabel: "muted",
    get fill() {
      return mocks.fill;
    },
  },
  useMobileTokens: () => ({ mutedForeground: "muted", foreground: "ink", destructive: "error" }),
  useResolvedAppearance: () => "light",
  useThemedStyles: (createStyles: () => unknown) => createStyles(),
}));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string | number>) =>
    text.replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? ""));
  return { t, useI18n: () => ({ t }) };
});
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("./bot-avatar-edit", () => ({
  avatarColor: (value: string) => value,
  avatarShape: () => null,
  isAvatarPhoto: () => false,
  withAvatarColor: (_value: string, color: string) => color,
  withAvatarShape: (value: string) => value,
}));
vi.mock("../components/native-segmented-control", () => ({
  NativeSegmentedControl: ({
    options,
    onChange,
  }: {
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
  }) =>
    options.map((option) =>
      createElement(
        "button",
        { type: "button", key: option.value, onClick: () => onChange(option.value) },
        option.label,
      ),
    ),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { type: "button", onClick: onPress, disabled }, label),
}));
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    onValueChange,
    value,
    disabled,
  }: {
    accessibilityLabel: string;
    onValueChange: (value: boolean) => void;
    value: boolean;
    disabled?: boolean;
  }) =>
    createElement("button", {
      type: "button",
      "aria-label": accessibilityLabel,
      role: "switch",
      "aria-checked": value,
      disabled,
      onClick: () => onValueChange(!value),
    }),
}));
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
    style,
  }: {
    title: string;
    actions: { id: string; title: string; state: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children: ReactNode;
    style?: unknown;
  }) =>
    createElement(
      "section",
      { "data-menu": title, "data-style": JSON.stringify(style) },
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
    mocks.fill = "light-fill";
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
  const expand = async () =>
    act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Advanced"]')!.click());
  const render = async () => {
    await act(async () => root.render(<BotSettingsScreen />));
    await expand();
  };
  const menu = () => container.querySelector('[data-menu="Device voice"]');

  it("matches Instructions to the rounded Description field", async () => {
    await render();
    const description = container.querySelector<HTMLElement>(
      '[placeholder="What this bot is for"]',
    )!;
    const instructions = container.querySelector<HTMLElement>('[aria-label="Instructions"]')!;
    const resolvedStyle = (input: HTMLElement) =>
      Object.assign({}, ...JSON.parse(input.dataset.style!).flat(Infinity));
    const descriptionStyle = resolvedStyle(description);
    expect(descriptionStyle).toMatchObject({ borderRadius: 11, padding: 16 });
    expect(resolvedStyle(instructions)).toMatchObject({
      borderRadius: descriptionStyle.borderRadius,
      padding: descriptionStyle.padding,
      minHeight: 120,
      textAlignVertical: "top",
    });
    expect(instructions.getAttribute("aria-multiline")).toBe("true");
  });

  it("refreshes input backgrounds when appearance changes", async () => {
    await render();
    const backgrounds = () =>
      [...container.querySelectorAll<HTMLElement>("textarea")].map(
        (input) =>
          Object.assign({}, ...JSON.parse(input.dataset.style!).flat(Infinity)).backgroundColor,
      );
    expect(backgrounds()).toEqual(Array(4).fill("light-fill"));
    mocks.fill = "dark-fill";
    await act(async () => root.render(<BotSettingsScreen />));
    expect(backgrounds()).toEqual(Array(4).fill("dark-fill"));
  });

  it("hides advanced controls until expanded and follows the shared order", async () => {
    await act(async () => root.render(<BotSettingsScreen />));
    for (const label of [
      "Computer",
      "Read replies aloud",
      "Device voice",
      "Manage the bots it creates",
    ]) {
      expect(container.textContent).not.toContain(label);
    }
    await expand();
    const labels = {
      instructions: "Instructions",
      computer: "Computer",
      model: "Model",
      readAloud: "Read replies aloud",
      voice: "Device voice",
      fleetManagement: "Manage the bots it creates",
    };
    const actual = [...container.querySelectorAll("span")].flatMap((span) =>
      Object.entries(labels)
        .filter(([, label]) => label === span.textContent)
        .map(([key]) => key),
    );
    expect(actual).toEqual(BOT_SETTINGS_ADVANCED_ORDER.filter((key) => key in labels));
    expect(actual).toEqual([
      "instructions",
      "computer",
      "model",
      "readAloud",
      "voice",
      "fleetManagement",
    ]);
    for (const label of Object.values(labels)) {
      const span = [...container.querySelectorAll("span")].find(
        (span) => span.textContent === label,
      )!;
      const style = JSON.parse(span.dataset.style!);
      const resolved = Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
      expect(resolved).toMatchObject({ color: "muted", fontSize: 14 });
    }

    await expand();
    expect(container.textContent).not.toContain("Read replies aloud");
  });

  it("saves read aloud and computer mode after expanding Advanced", async () => {
    mocks.rpc.mockResolvedValue(undefined);
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Read replies aloud"]')!.click(),
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Private")!
        .click(),
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Save")!
        .click(),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("bots/setComputer", {
      botId: "bot-fixture",
      mode: "dedicated",
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "bots/update",
      expect.objectContaining({ botId: "bot-fixture", autoSpeak: true }),
    );
  });

  it("shows bot management help in a native alert from an accessible button", async () => {
    await render();
    const help = container.querySelector<HTMLButtonElement>(
      '[aria-label="About Manage the bots it creates"]',
    );
    expect(help?.getAttribute("role")).toBe("button");
    const explanation =
      "Organize the sidebar and edit bots. Instruction, model, routine and group edits need approval.";
    expect(help?.getAttribute("data-hint")).toBe(explanation);
    expect(container.textContent).not.toContain(explanation);
    await act(async () => help?.click());
    expect(mocks.alert).toHaveBeenCalledExactlyOnceWith("Manage the bots it creates", explanation);
  });

  it("persists bot management toggles immediately without adding them to unrelated saves", async () => {
    mocks.rpc.mockResolvedValue(undefined);
    await render();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Manage the bots it creates"]',
    );
    if (!toggle) throw new Error("Missing bot management switch");
    await act(async () => {
      toggle.click();
    });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bots/update", {
      botId: "bot-fixture",
      fleetManagement: true,
    });
    mocks.rpc.mockClear();
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    );
    if (!save) throw new Error("Missing Save");
    await act(async () => {
      save.click();
    });
    for (const [, input] of mocks.rpc.mock.calls)
      expect(input).not.toHaveProperty("fleetManagement");
  });

  it("keeps the switch and Save enabled while saving and coalesces rapid toggles", async () => {
    const first = deferredSave();
    const last = deferredSave();
    mocks.rpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    await render();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Manage the bots it creates"]',
    )!;
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    )!;
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.disabled).toBe(false);
    expect(save.disabled).toBe(false);
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve());
    expect(mocks.rpc.mock.calls).toEqual([
      ["bots/update", { botId: "bot-fixture", fleetManagement: true }],
      ["bots/update", { botId: "bot-fixture", fleetManagement: false }],
    ]);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => last.reject(new Error("latest save failed")));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("latest save failed");
    expect(toggle.disabled).toBe(false);
  });

  it.each([false, true])(
    "waits for the full bot management queue before leaving (failure: %s)",
    async (fails) => {
      const first = deferredSave();
      const last = deferredSave();
      mocks.rpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
      await render();
      const toggle = container.querySelector<HTMLButtonElement>(
        '[aria-label="Manage the bots it creates"]',
      )!;
      const save = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Save",
      )!;
      await act(async () => toggle.click());
      await act(async () => save.click());
      expect(mocks.back).not.toHaveBeenCalled();
      expect(toggle.disabled).toBe(false);
      await act(async () => toggle.click());
      await act(async () => first.resolve());
      expect(mocks.back).not.toHaveBeenCalled();
      expect(mocks.rpc).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (fails) last.reject(new Error("bot management write failed"));
        else last.resolve();
      });
      if (fails) {
        expect(mocks.back).not.toHaveBeenCalled();
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        expect(container.textContent).toContain("bot management write failed");
        expect(toggle.disabled).toBe(false);
      } else {
        expect(mocks.back).toHaveBeenCalledOnce();
      }
    },
  );

  it("keeps a failed bot management write visible when Save is pressed after rollback", async () => {
    mocks.rpc.mockRejectedValueOnce(new Error("offline"));
    await render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Manage the bots it creates"]')!
        .click(),
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Save")!
        .click(),
    );
    expect(mocks.back).not.toHaveBeenCalled();
    expect(container.textContent).toContain("offline");
  });

  it("does not resend saved edits when Save is retried after a failed bot management write", async () => {
    mocks.rpc.mockResolvedValue(undefined);
    mocks.rpc.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({
      instructions: "",
      autoSpeak: true,
      instructionHistory: [
        { id: "v1", instructions: "Older", reason: "edit", createdAt: "2026-10-21T18:00:00Z" },
      ],
    });
    await render();
    expect(container.querySelector('[data-menu="Instruction history"]')).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Manage the bots it creates"]',
    )!;
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    )!;
    await act(async () => toggle.click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Read replies aloud"]')!.click(),
    );
    await act(async () => save.click());
    expect(mocks.rpc).toHaveBeenLastCalledWith("bots/update", {
      botId: "bot-fixture",
      autoSpeak: true,
    });
    expect(mocks.back).not.toHaveBeenCalled();
    expect(container.textContent).toContain("offline");
    expect(container.querySelector('[data-menu="Instruction history"]')).not.toBeNull();
    await act(async () => toggle.click());
    mocks.rpc.mockClear();
    await act(async () => save.click());
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.back).toHaveBeenCalledOnce();
  });

  it("coalesces a queued value matching the confirmed save", async () => {
    const first = deferredSave();
    mocks.rpc.mockReturnValueOnce(first.promise);
    await render();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Manage the bots it creates"]',
    )!;
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    await act(async () => first.resolve());
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("restores the bot management toggle when saving fails", async () => {
    mocks.rpc.mockRejectedValueOnce(new Error("offline"));
    await render();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Manage the bots it creates"]',
    );
    if (!toggle) throw new Error("Missing bot management switch");
    await act(async () => {
      toggle.click();
    });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bots/update", {
      botId: "bot-fixture",
      fleetManagement: true,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(false);
    expect(container.textContent).toContain("offline");
  });

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
    expect(menu()!.firstElementChild).toBe(row);
    expect(JSON.parse(row.dataset.style!)[0]).toEqual(
      JSON.parse(label("Read replies aloud").parentElement!.dataset.style!),
    );
    expect(menu()!.contains(label("Device voice"))).toBe(true);
    const trigger = menu()!.firstElementChild!;
    expect(trigger.getAttribute("role")).toBe("button");
    expect(trigger.getAttribute("aria-label")).toBe("Device voice");
    expect(trigger.getAttribute("aria-valuetext")).toBe("en-US · Alice");
    expect(label("en-US · Alice").dataset.style).toContain('"textAlign":"right"');
    expect(menu()!.querySelector("i")!.dataset).toMatchObject({
      ios: "chevron.up.chevron.down",
      android: "chevron-expand",
    });
    await act(async () =>
      mocks.layouts.get(menu()!.parentElement!)!({ nativeEvent: { layout: { width: 320 } } }),
    );
    expect(JSON.parse(row.dataset.style!).at(-1)).toEqual({ width: 320 });
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
      expect(
        [...container.querySelectorAll("span")]
          .find((span) => span.textContent === "Device voice")!
          .parentElement!.querySelector('i[data-ios="chevron.up.chevron.down"]'),
      ).toBeNull();
    },
  );

  it("keeps a destructive retry row after failure and replaces it with a menu on success", async () => {
    mocks.deviceVoices.mockRejectedValueOnce(new Error("Load failed"));
    await render();
    expect(menu()).toBeNull();
    expect(
      [...container.querySelectorAll("span")]
        .find((span) => span.textContent === "Device voice")!
        .parentElement!.querySelector('i[data-ios="chevron.up.chevron.down"]'),
    ).toBeNull();
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

  it.each([false, true])(
    "sizes the menu trigger to its measured width (plain=%s)",
    async (plain) => {
      await act(async () =>
        root.render(
          <MenuPicker
            choices={[{ key: "", label: "Space default" }]}
            divider
            label="Model"
            onChange={vi.fn()}
            plain={plain}
            value=""
          />,
        ),
      );
      const nativeMenu = container.querySelector<HTMLElement>('[data-menu="Model"]')!;
      const trigger = nativeMenu.firstElementChild as HTMLElement;
      const triggerStyle = () => Object.assign({}, ...JSON.parse(trigger.dataset.style!).flat());
      expect(triggerStyle()).toMatchObject({ alignSelf: "stretch" });
      expect(triggerStyle().width).toBeUndefined();
      expect(JSON.parse(nativeMenu.dataset.style!)).toEqual({ alignSelf: "stretch" });
      for (const width of [320, 480]) {
        await act(async () =>
          mocks.layouts.get(nativeMenu.parentElement!)!({ nativeEvent: { layout: { width } } }),
        );
        expect(triggerStyle().width).toBe(width);
      }
    },
  );
});
