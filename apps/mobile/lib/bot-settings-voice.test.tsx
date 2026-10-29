// @vitest-environment jsdom

import { BOT_COLORS, BOT_SETTINGS_SECTIONS } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BotSettingsScreen from "../app/bot-settings";
import { MenuPicker } from "../components/menu-picker";

const mocks = vi.hoisted(() => ({
  instructions: "",
  description: "",
  crossSpaceCommunication: false,
  avatarSet: undefined as "organic" | "rakazo" | undefined,
  focus: undefined as string | undefined,
  os: "ios",
  work: [] as unknown[],
  history: [] as unknown[],
  share: vi.fn(),
  docs: [] as unknown[],
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
  prompt: vi.fn(),
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

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./bot-voices", () => ({
  voiceLabel: (voice: { language: string; name: string }) => `${voice.name} (${voice.language})`,
  deviceVoices: mocks.deviceVoices,
  voiceForBot: mocks.voiceForBot,
  setVoiceForBot: mocks.setVoiceForBot,
}));
vi.mock("./device-voice", () => ({ loadDeviceVoiceEnabled: async () => true }));
vi.mock("./voice", () => ({ stopVoicePlayback: mocks.stopVoicePlayback }));
vi.mock("expo-speech", () => ({ stop: mocks.stop, speak: mocks.speak }));
vi.mock("./api", () => ({
  rpc: async (procedure: string, input?: unknown) => {
    if (
      [
        "bots/update",
        "bots/setComputer",
        "scratchpad/create",
        "scratchpad/update",
        "bots/restoreInstructions",
        "export/bot",
        "threads/clear",
      ].includes(procedure)
    )
      return mocks.rpc(procedure, input);
    if (procedure === "bots/get")
      return {
        id: "bot-fixture",
        name: "Fixture",
        title: "",
        instructions: mocks.instructions,
        description: mocks.description,
        instructionHistory: mocks.history,
        color: BOT_COLORS[0],
        avatarSet: mocks.avatarSet,
        autoSpeak: false,
        computerMode: "team",
        fleetManagement: false,
        crossSpaceCommunication: mocks.crossSpaceCommunication,
      };
    if (procedure === "scratchpad/list") return mocks.work;
    if (procedure === "memory/list") return mocks.docs;
    if (procedure === "me") return {};
    return [];
  },
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back: mocks.back }),
  useLocalSearchParams: () => ({ botId: "bot-fixture", focus: mocks.focus }),
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
    Alert: { alert: mocks.alert, prompt: mocks.prompt },
    Share: { share: mocks.share },
    Platform: {
      get OS() {
        return mocks.os;
      },
    },
    useWindowDimensions: () => ({ fontScale: 1 }),
    StyleSheet: { create: (styles: unknown) => styles },
    Modal: view,
    ScrollView: view,
    View: view,
    Text: ({
      children,
      style,
      accessibilityRole,
      allowFontScaling,
    }: {
      children?: ReactNode;
      style: unknown;
      accessibilityRole?: string;
      allowFontScaling?: boolean;
    }) =>
      createElement(
        "span",
        {
          "data-style": JSON.stringify(style),
          role: accessibilityRole,
          "data-font-scaling": allowFontScaling ?? true,
        },
        children,
      ),
    TextInput: ({
      style,
      accessibilityLabel,
      placeholder,
      multiline,
      value,
      onChangeText,
      scrollEnabled,
    }: {
      value: string;
      onChangeText?: (value: string) => void;
      scrollEnabled?: boolean;
      style?: unknown;
      accessibilityLabel?: string;
      placeholder?: string;
      multiline?: boolean;
    }) =>
      createElement("textarea", {
        value,
        onChange: () => undefined,
        onInput: (event: { currentTarget: HTMLTextAreaElement }) =>
          onChangeText?.(event.currentTarget.value),
        "data-scroll-enabled": scrollEnabled,
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
      accessibilityState,
      style,
      hitSlop,
    }: {
      children?: ReactNode;
      onPress: () => void;
      accessibilityLabel?: string;
      accessibilityHint?: string;
      accessibilityRole?: string;
      accessibilityState?: { expanded?: boolean };
      style?: unknown;
      hitSlop?: number;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          "aria-label": accessibilityLabel,
          "data-hint": accessibilityHint,
          role: accessibilityRole,
          "aria-expanded": accessibilityState?.expanded,
          "data-style": JSON.stringify(style),
          "data-hit-slop": hitSlop,
        },
        children,
      ),
  };
});
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
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
    mocks.crossSpaceCommunication = false;
    mocks.avatarSet = undefined;
    vi.clearAllMocks();
    mocks.focus = undefined;
    mocks.instructions = "";
    mocks.description = "";
    mocks.os = "ios";
    mocks.work = [];
    mocks.history = [];
    mocks.docs = [];
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

  it.each([false, true])("loads and saves cross-space communication: %s", async (enabled) => {
    mocks.crossSpaceCommunication = enabled;
    await render();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Allow cross-space bot communication"]',
    )!;
    expect(toggle.getAttribute("aria-checked")).toBe(String(enabled));
    await act(async () => toggle.click());
    expect(mocks.rpc).toHaveBeenCalledWith("bots/update", {
      botId: "bot-fixture",
      crossSpaceCommunication: !enabled,
    });
  });

  it.each(["ios", "android"])(
    "uses muted section disclosure and nonrepeating labels on %s",
    async (os) => {
      mocks.os = os;
      await act(async () => root.render(<BotSettingsScreen />));
      const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Advanced"]')!;
      expect(trigger.getAttribute("role")).toBe("button");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(JSON.parse(trigger.dataset.style!)).toMatchObject({ minHeight: 44 });
      expect(JSON.parse(trigger.dataset.style!)).not.toHaveProperty("backgroundColor");
      expect(JSON.parse(trigger.querySelector("span")!.dataset.style!)).toEqual([
        { fontSize: 12, fontWeight: "500", flexShrink: 1 },
        { color: "muted" },
      ]);
      const heading = [...container.querySelectorAll('[role="header"]')].find(
        (node) => node.textContent === "Notifications",
      )!;
      expect(heading).toBeDefined();
      expect(JSON.parse((heading.parentElement as HTMLElement).dataset.style!)).toMatchObject({
        gap: 8,
      });
      expect(
        container.querySelector('[role="switch"][aria-label="When it finishes or needs input"]'),
      ).not.toBeNull();
      await expand();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      const model = container.querySelector('[data-menu="Model"]')!;
      expect([...model.querySelectorAll("span")].some((node) => node.textContent === "Model")).toBe(
        false,
      );
      expect(model.querySelector('[aria-label="Model"]')).not.toBeNull();
      await expand();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    },
  );

  it("adds work from the native prompt and completes it with a leading checkbox", async () => {
    mocks.work = [{ id: "first", title: "First task", notes: "", status: "open" }];
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Add open work"]')!.click(),
    );
    expect(mocks.prompt).toHaveBeenCalledWith(
      "Add open work",
      undefined,
      expect.any(Array),
      "plain-text",
      "",
    );
    mocks.rpc.mockResolvedValueOnce({ id: "new", title: "New task", notes: "", status: "open" });
    const buttons = mocks.prompt.mock.calls.at(-1)![2];
    await act(async () =>
      buttons.find((button: { text: string }) => button.text === "Save").onPress("New task"),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("scratchpad/create", {
      botId: "bot-fixture",
      title: "New task",
    });
    const complete = container.querySelector<HTMLButtonElement>(
      '[aria-label="Complete New task"]',
    )!;
    expect(complete.getAttribute("role")).toBe("checkbox");
    expect(JSON.parse(complete.dataset.style!)).toMatchObject({ minHeight: 22, width: 22 });
    expect(complete.dataset.hitSlop).toBe("11");
    mocks.rpc.mockResolvedValueOnce({});
    await act(async () => complete.click());
    expect(mocks.rpc).toHaveBeenCalledWith("scratchpad/update", { itemId: "new", status: "done" });
    expect(container.textContent).not.toContain("New task");
  });

  it("restores instructions through the history icon's native menu", async () => {
    mocks.history = [
      {
        id: "v1",
        instructions: "Earlier",
        reason: "Manual edit",
        createdAt: "2026-10-01T00:00:00Z",
      },
    ];
    await render();
    const history = container.querySelector('[data-menu="Instruction history"]')!;
    expect(history.querySelector('[aria-label="Instruction history"]')).not.toBeNull();
    await act(async () => history.querySelector<HTMLButtonElement>("button")!.click());
    expect(mocks.alert).toHaveBeenCalledWith("Restore", "Earlier", expect.any(Array));
    mocks.rpc.mockResolvedValueOnce({ id: "bot-fixture", instructions: "Earlier" });
    await act(async () => mocks.alert.mock.calls.at(-1)![2][1].onPress());
    expect(mocks.rpc).toHaveBeenCalledWith("bots/restoreInstructions", {
      botId: "bot-fixture",
      versionId: "v1",
      expectedInstructions: "",
    });
  });

  it("exports through the share sheet and confirms conversation clearing", async () => {
    await render();
    mocks.rpc.mockResolvedValueOnce({ version: 1 });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Export"]')!.click(),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("export/bot", { botId: "bot-fixture" });
    expect(mocks.share).toHaveBeenCalledWith({ message: JSON.stringify({ version: 1 }, null, 2) });
    mocks.rpc.mockClear();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Clear conversation"]')!.click(),
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValueOnce({ ok: true });
    await act(async () => mocks.alert.mock.calls.at(-1)![2][1].onPress());
    expect(mocks.rpc).toHaveBeenCalledWith("threads/clear", { botId: "bot-fixture" });
  });

  it("opens avatar controls from the header and closes the sheet", async () => {
    await render();
    expect(container.textContent).not.toContain("Shape");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit avatar"]')!.click(),
    );
    expect(container.textContent).toContain("Shape");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Done")!
        .click(),
    );
    expect(container.textContent).not.toContain("Shape");
  });

  it("keeps a legacy set until explicitly switched, saves the choice, and reloads it", async () => {
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit avatar"]')!.click(),
    );
    const setMenu = () => container.querySelector('[data-menu="Icon set"]')!;
    const option = (label: string) =>
      [...setMenu().querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === label,
      )!;
    expect(option("Original").dataset.state).toBe("on");
    expect(mocks.rpc).not.toHaveBeenCalled();
    await act(async () => option("Rakazo").click());
    mocks.rpc.mockResolvedValueOnce({ avatarSet: "rakazo" });
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Save")!
        .click(),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("bots/update", {
      botId: "bot-fixture",
      avatarSet: "rakazo",
    });
    act(() => root.unmount());
    root = createRoot(container);
    mocks.avatarSet = "rakazo";
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit avatar"]')!.click(),
    );
    expect(option("Rakazo").dataset.state).toBe("on");
    await act(async () => option("Original").click());
    mocks.rpc.mockResolvedValueOnce({ avatarSet: "organic" });
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Save")!
        .click(),
    );
    expect(mocks.rpc).toHaveBeenLastCalledWith("bots/update", {
      botId: "bot-fixture",
      avatarSet: "organic",
    });
  });

  it("expands Advanced for a native model deep link", async () => {
    mocks.focus = "model";
    await act(async () => root.render(<BotSettingsScreen />));
    expect(container.querySelector('[aria-label="Advanced"]')?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(container.textContent).toContain("Model");
  });

  it("commits a native profile prompt immediately and leaves cancellation unchanged", async () => {
    mocks.rpc.mockResolvedValue(undefined);
    await act(async () => root.render(<BotSettingsScreen />));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit name"]')!.click(),
    );
    const buttons = mocks.prompt.mock.lastCall![2] as { onPress?: (value?: string) => void }[];
    await act(async () => buttons[1]!.onPress!("Atlas"));
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bots/update", {
      botId: "bot-fixture",
      name: "Atlas",
    });
    expect(container.querySelector('[aria-label="Edit name"]')?.textContent).toBe("Atlas");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit name"]')!.click(),
    );
    const cancel = (mocks.prompt.mock.lastCall![2] as { onPress?: () => void }[])[0]!;
    await act(async () => cancel.onPress?.());
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="Edit name"]')?.textContent).toBe("Atlas");
  });

  it("shows a quiet header with no Save or empty context groups", async () => {
    await act(async () => root.render(<BotSettingsScreen />));
    expect(container.textContent).not.toContain("Open work");
    expect(container.textContent).not.toContain("Memory");
    expect(
      [...container.querySelectorAll("button")].some((button) => button.textContent === "Save"),
    ).toBe(false);
  });

  it("limits open work and memory lists until Show more", async () => {
    mocks.work = Array.from({ length: 7 }, (_, i) => ({
      id: `task-${i}`,
      title: `Task ${i}`,
      notes: "",
      status: "open",
    }));
    mocks.docs = Array.from({ length: 7 }, (_, i) => ({
      id: `doc-${i}`,
      path: `notes/${i}.md`,
      content: "Fixture notes",
    }));
    await act(async () => root.render(<BotSettingsScreen />));
    expect(container.textContent).not.toContain("Task 6");
    expect(container.textContent).not.toContain("notes/6.md");
    for (const button of [...container.querySelectorAll("button")].filter(
      (node) => node.textContent === "Show more",
    ))
      await act(async () => button.click());
    expect(container.textContent).toContain("Task 6");
    expect(container.textContent).toContain("notes/6.md");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="notes/6.md"]')!.click(),
    );
    expect(mocks.alert).toHaveBeenCalledWith("notes/6.md", "Fixture notes");
  });

  it("uses a dialog rather than inline fields on Android", async () => {
    mocks.os = "android";
    await act(async () => root.render(<BotSettingsScreen />));
    expect(container.querySelector('[aria-label="Name"]')).toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit name"]')!.click(),
    );
    expect(container.querySelector('[aria-label="Name"]')).not.toBeNull();
    expect(mocks.prompt).not.toHaveBeenCalled();
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((node) => node.textContent === "Cancel")!
        .click(),
    );
    expect(container.querySelector('[aria-label="Name"]')).toBeNull();
  });

  it("sizes multiline editors from an unconstrained copy of their loaded content", async () => {
    mocks.instructions = "First line\nSecond line\nThird line\nFourth line\nFifth line";
    mocks.description = mocks.instructions;
    await render();
    for (const label of ["Instructions", "How other bots see it"]) {
      const input = container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
      const style = Object.assign({}, ...JSON.parse(input.dataset.style!).flat(Infinity));
      expect(style).toMatchObject({ position: "absolute", top: 0, bottom: 0, lineHeight: 22 });
      expect(input.dataset.scrollEnabled).toBe("false");
      expect(style.height).toBeUndefined();
      expect(style.maxHeight).toBeUndefined();
      const measure = input.previousElementSibling as HTMLElement;
      expect(measure.textContent).toBe(`${mocks.instructions}\u200b`);
      const measureStyle = Object.assign({}, ...JSON.parse(measure.dataset.style!).flat(Infinity));
      expect(measureStyle).toMatchObject({ minHeight: 98, lineHeight: 22, opacity: 0 });
      expect(measureStyle.height).toBeUndefined();
      expect(measureStyle.maxHeight).toBeUndefined();
      expect(style.padding).toBe(measureStyle.padding);
      await act(async () => {
        (input as HTMLTextAreaElement).value = "Short";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(measure.textContent).toBe("Short\u200b");
      await act(async () => {
        (input as HTMLTextAreaElement).value = "Line\n".repeat(20);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(measure.textContent).toBe(`${"Line\n".repeat(20)}\u200b`);
    }
  });

  it("hides advanced controls until expanded and follows the shared order", async () => {
    await act(async () => root.render(<BotSettingsScreen />));
    for (const label of [
      "Model",
      "Thinking",
      "Computer",
      "Read replies aloud",
      "Device voice",
      "Manage the bots it creates",
      "Instructions",
    ]) {
      expect(container.textContent).not.toContain(label);
    }
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Advanced"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("role")).toBe("button");
    expect(JSON.parse(trigger.dataset.style!)).toMatchObject({ marginTop: 24, minHeight: 44 });
    const headings = [...container.querySelectorAll<HTMLElement>('[role="header"]')];
    expect(headings.map((heading) => heading.textContent)).toEqual(["Notifications"]);
    expect(trigger.querySelector('[data-ios="chevron.right"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Instructions"]')).toBeNull();
    await expand();
    expect(container.querySelector('[aria-label="Instructions"]')).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.querySelector('[data-ios="chevron.down"]')).not.toBeNull();
    expect(JSON.parse((trigger.nextElementSibling as HTMLElement).dataset.style!)).toMatchObject({
      gap: 24,
      marginTop: 24,
    });
    const labels = {
      instructions: "Instructions",
      computer: "Computer",
      model: "Model",
      readAloud: "Read replies aloud",
      voice: "Device voice",
      crossSpaceCommunication: "Allow cross-space bot communication",
      fleetManagement: "Manage the bots it creates",
    };
    const actual = [...container.querySelectorAll("span")].flatMap((span) =>
      Object.entries(labels)
        .filter(
          ([key, label]) =>
            label === span.textContent &&
            (span.getAttribute("role") !== "header" || key === "model"),
        )
        .map(([key]) => key),
    );
    expect(actual).toEqual(
      Object.values(BOT_SETTINGS_SECTIONS)
        .flat()
        .filter((key) => key in labels && key !== "instructions" && key !== "computer"),
    );
    expect(actual).toEqual([
      "model",
      "readAloud",
      "voice",
      "crossSpaceCommunication",
      "fleetManagement",
    ]);

    await expand();
    expect(container.textContent).not.toContain("Read replies aloud");
  });

  it("queues notifications and ignores an older failure before saving the latest choice", async () => {
    const first = deferredSave();
    mocks.rpc.mockReturnValueOnce(first.promise);
    await render();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="When it finishes or needs input"]',
    )!;
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    mocks.rpc.mockResolvedValueOnce(undefined);
    await act(async () => first.reject(new Error("older failure")));
    expect(mocks.rpc).toHaveBeenLastCalledWith("bots/update", {
      botId: "bot-fixture",
      notifyOnFinish: false,
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).not.toContain("older failure");
    mocks.rpc.mockRejectedValueOnce(new Error("latest failure"));
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("latest failure");
  });

  it.each([
    { firstFails: false, latestFails: false },
    { firstFails: true, latestFails: false },
    { firstFails: false, latestFails: true },
    { firstFails: true, latestFails: true },
  ])(
    "serializes name edits (first fails: $firstFails, latest fails: $latestFails)",
    async ({ firstFails, latestFails }) => {
      const first = deferredSave();
      const last = deferredSave();
      mocks.rpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
      await render();
      const edit = async (value: string) => {
        await act(async () =>
          container.querySelector<HTMLButtonElement>('[aria-label="Edit name"]')!.click(),
        );
        const buttons = mocks.prompt.mock.calls.at(-1)![2];
        await act(async () =>
          buttons.find((button: { text: string }) => button.text === "Save").onPress(value),
        );
      };
      await edit("First");
      await edit("Latest");
      expect(mocks.rpc.mock.calls).toEqual([
        ["bots/update", { botId: "bot-fixture", name: "First" }],
      ]);
      expect(container.textContent).toContain("Latest");
      await act(async () => {
        if (firstFails) first.reject(new Error("older failure"));
        else first.resolve();
      });
      expect(container.textContent).not.toContain("older failure");
      expect(mocks.rpc).toHaveBeenLastCalledWith("bots/update", {
        botId: "bot-fixture",
        name: "Latest",
      });
      expect(container.textContent).toContain("Latest");
      await act(async () => {
        if (latestFails) last.reject(new Error("latest failure"));
        else last.resolve();
      });
      const shown = container.querySelector('[aria-label="Edit name"]')!;
      expect(shown.textContent).toBe(latestFails ? (firstFails ? "Fixture" : "First") : "Latest");
      expect(
        [...container.querySelectorAll("button")].some((node) => node.textContent === "Save"),
      ).toBe(false);
    },
  );

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
    if (!save) {
      expect(container.querySelector('[aria-label="Save"]')).toBeNull();
      return;
    }
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
    expect(save).toBeUndefined();
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
      let fleetCalls = 0;
      mocks.rpc.mockImplementation((_procedure: string, input: { fleetManagement?: boolean }) =>
        input.fleetManagement === undefined
          ? Promise.resolve(undefined)
          : ++fleetCalls === 1
            ? first.promise
            : last.promise,
      );
      await render();
      const toggle = container.querySelector<HTMLButtonElement>(
        '[aria-label="Manage the bots it creates"]',
      )!;
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Read replies aloud"]')!.click(),
      );
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
      expect(mocks.rpc).toHaveBeenCalledTimes(3);
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

  it("keeps a failed bot management write visible without an unrelated Save", async () => {
    mocks.rpc.mockRejectedValueOnce(new Error("offline"));
    await render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Manage the bots it creates"]')!
        .click(),
    );
    expect(
      [...container.querySelectorAll("button")].some((button) => button.textContent === "Save"),
    ).toBe(false);
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
    await act(async () => toggle.click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Read replies aloud"]')!.click(),
    );
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    )!;
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
    expect(
      [...container.querySelectorAll("button")].some((button) => button.textContent === "Save"),
    ).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
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
      ["Alice (en-US)", "on"],
      ["Beth (en-GB)", "off"],
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
    expect(trigger.getAttribute("aria-valuetext")).toBe("Alice (en-US)");
    expect(label("Alice (en-US)").dataset.style).toContain('"textAlign":"right"');
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

it("opens a native name prompt from the centred header", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<BotSettingsScreen />));
  expect(host.querySelector('[placeholder="Name this bot"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Edit name"]')!.click());
  expect(mocks.prompt).toHaveBeenCalledWith(
    "Name",
    undefined,
    expect.any(Array),
    "plain-text",
    "Fixture",
  );
  await act(async () => root.unmount());
});

it.each(["  \n", "# Fixture\n\n"])("hides empty memory: %j", async (content) => {
  mocks.docs = [{ id: "empty", path: "MEMORY.md", content }];
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<BotSettingsScreen />));
    expect(host.textContent).not.toContain("MEMORY.md");
  } finally {
    await act(async () => root.unmount());
  }
});
