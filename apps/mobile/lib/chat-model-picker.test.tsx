// @vitest-environment jsdom

import { notifyManager } from "@tanstack/react-query";
import type { CSSProperties, ReactNode, Ref } from "react";
import { act, createElement, useEffect, useImperativeHandle } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelConnection from "../app/(settings)/model-connection";
import SettingsModelPickerScreen from "../app/(settings)/model-picker";
import Models from "../app/(settings)/models";
import BotModelScreen from "../app/bot-model";
import BotSettingsScreen from "../app/bot-settings";
import { ModelPickerList } from "../components/model-picker-list";
import type { ModelConnectionRequest } from "./model-connection-request";
import { modelConnectionRequest, openModelConnection } from "./model-connection-request";
import { modelPickerRequest } from "./model-picker-selection";
import { queryClient } from "./query";

const mocks = vi.hoisted(() => ({
  scrollToLocation: vi.fn(),
  scrollTo: vi.fn(),
  reportVisibleRows: true,
  headerInset: 0,
  focused: true,
  platform: "ios",
  connected: true,
  serverCredentials: false,
  catalogEmpty: false,
  extraProviders: false,
  gateway: false,
  workers: false,
  savedMaxTokens: undefined as number | undefined,
  savedAccountId: "account-fixture",
  savedGatewayId: "gateway-fixture",
  vendorLabels: false,
  subscriptionSignIn: false,
  secondConnection: false,
  alert: vi.fn(),
  prompt: vi.fn(),
  completeOAuth: vi.fn(),
  rpc: vi.fn(),
  dismissKeyboard: vi.fn(),
  listProps: {} as Record<string, unknown>,
  params: {} as Record<string, string | undefined>,
  update: vi.fn(),
  push: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
  dismissTo: vi.fn(),
  setParams: vi.fn(),
  setOptions: vi.fn(),
  announce: vi.fn(),
  backups: [] as { provider: string; modelId: string }[] | Promise<unknown>,
  primary: null as { provider: string; modelId: string; thinkingLevel?: string | null } | null,
  menus: new Map<
    string,
    {
      actions: {
        id: string;
        title: string;
        subactions?: { id: string; title: string; state: string }[];
      }[];
      onPressAction: (event: { nativeEvent: { event: string } }) => void;
    }
  >(),
  rowAccessibilityActions: new Map<
    string,
    (event: { nativeEvent: { actionName: string } }) => void
  >(),
}));

/** The deployment's approval model, shown when the member chose none. */
const APPROVAL_DEFAULT = { provider: "openrouter", modelId: "vendor/model-1" };
const CREDENTIAL_ID = "credential-fixture";
const WORK_CREDENTIAL_ID = "credential-work";

const catalog = Array.from({ length: 11 }, (_, index) => ({
  provider: "openrouter",
  providerName: "OpenRouter",
  id: `vendor/model-${index + 1}`,
  label: `Model ${index + 1}`,
  billing: "",
  auth: "api-key",
  thinkingLevels: ["low", "medium", "high"],
}));

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 34 }),
  SafeAreaView: ({ children }: { children: ReactNode }) => createElement("div", {}, children),
}));
vi.mock("./floating-header", () => ({ useFloatingHeaderInset: () => mocks.headerInset }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));

vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  captureApiRequestContext: async () => ({ headers: {} }),
  selectedSpaceId: () => "space-fixture",
  rpc: async (procedure: string, input?: unknown, options?: { signal?: AbortSignal }) => {
    const cloudflare = mocks.gateway
      ? { provider: "cloudflare-ai-gateway", providerName: "Cloudflare AI Gateway" }
      : mocks.workers
        ? { provider: "cloudflare-workers-ai", providerName: "Cloudflare Workers AI" }
        : undefined;
    const result = mocks.rpc(procedure, input);
    if (procedure === "models/connect") {
      await result;
      const saved = input as {
        maxTokens?: number | null;
        accountId?: string;
        gatewayId?: string;
      };
      // A null limit clears it, as the server does.
      mocks.savedMaxTokens = saved.maxTokens ?? undefined;
      if (saved.accountId) mocks.savedAccountId = saved.accountId;
      if (saved.gatewayId) mocks.savedGatewayId = saved.gatewayId;
      return { id: CREDENTIAL_ID };
    }
    if (procedure === "models/beginOAuth")
      return {
        loginId: "login-fixture",
        mode: "device-code",
        verificationUri: "https://example.com/sign-in",
        userCode: "FIXTURE",
        expiresInSeconds: 600,
      };
    if (procedure === "models/completeOAuth") return mocks.completeOAuth(options?.signal);
    if (procedure === "bots/update") return mocks.update(input);
    if (procedure === "models/role") {
      const main = (input as { role: string }).role === "main";
      return {
        primary: main ? mocks.primary : null,
        backups: main ? await mocks.backups : [],
        deploymentPrimary: main ? null : APPROVAL_DEFAULT,
      };
    }
    if (procedure === "models/forRole") return mocks.catalogEmpty ? [] : catalog;
    if (procedure === "models/setRole") {
      await result;
      const patch = input as Partial<{
        role: string;
        primary: typeof mocks.primary;
        backups: { provider: string; modelId: string }[];
      }>;
      if (patch.role !== "main")
        return {
          primary: patch.primary ?? null,
          backups: patch.backups ?? [],
          deploymentPrimary: APPROVAL_DEFAULT,
        };
      // The main list persists like the server so a reload after a promotion keeps it.
      if (patch.primary !== undefined) mocks.primary = patch.primary;
      if (patch.backups) mocks.backups = patch.backups;
      return { primary: mocks.primary, backups: await mocks.backups };
    }
    if (procedure === "models/setDefault") return result;
    if (procedure === "bots/get")
      return { id: "bot-fixture", name: "Fixture", title: "", computerMode: "team" };
    if (procedure === "me")
      return {
        userId: "user-fixture",
        spaceId: "space-fixture",
        defaultProvider: cloudflare?.provider ?? "openrouter",
        defaultModel: "vendor/model-1",
        hostCredentialProvider: mocks.serverCredentials ? "openrouter" : undefined,
      };
    if (procedure === "models/list")
      return mocks.catalogEmpty
        ? []
        : mocks.vendorLabels
          ? catalog.map((entry, index) => ({
              ...entry,
              label:
                index === 0
                  ? "Anthropic: Claude Sonnet 4.5"
                  : index === 1
                    ? "Google: Gemini"
                    : entry.label,
            }))
          : mocks.subscriptionSignIn
            ? catalog.map((entry) => ({ ...entry, signIn: "device-code" }))
            : [
                ...catalog.map((entry) => ({
                  ...entry,
                  provider: cloudflare?.provider ?? entry.provider,
                  providerName: cloudflare?.providerName ?? entry.providerName,
                })),
                ...(mocks.extraProviders
                  ? ["Anthropic", "Google", "OpenAI", "Other", "Last"].map((name) => ({
                      ...catalog[0],
                      provider: name.toLowerCase(),
                      providerName: name,
                    }))
                  : []),
              ];
    if (procedure === "models/credentials")
      return mocks.connected
        ? [
            {
              id: CREDENTIAL_ID,
              provider: cloudflare?.provider ?? "openrouter",
              label: cloudflare?.providerName ?? "OpenRouter",
              maxTokens: mocks.savedMaxTokens,
              ...(mocks.gateway
                ? { accountId: mocks.savedAccountId, gatewayId: mocks.savedGatewayId }
                : mocks.workers
                  ? { accountId: mocks.savedAccountId }
                  : {}),
              modelId: "vendor/model-1",
              isDefault: true,
              thinkingLevel: "high",
            },
            ...(mocks.secondConnection
              ? [
                  {
                    id: WORK_CREDENTIAL_ID,
                    provider: "openrouter",
                    label: "Work",
                    hasKey: true,
                    isDefault: false,
                    authKind: "api_key",
                  },
                ]
              : []),
          ]
        : [];
    return [];
  },
}));
vi.mock("./bot-voices", () => ({
  voiceLabel: () => "",
  deviceVoices: async () => [],
  voiceForBot: async () => undefined,
  setVoiceForBot: async () => undefined,
}));
vi.mock("./device-voice", () => ({ loadDeviceVoiceEnabled: async () => false }));
vi.mock("./voice", () => ({ stopVoicePlayback: () => undefined }));
vi.mock("expo-speech", () => ({ stop: async () => undefined, speak: () => undefined }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({
    back: mocks.back,
    push: mocks.push,
    replace: mocks.replace,
    dismissTo: mocks.dismissTo,
    setParams: mocks.setParams,
  }),
  useNavigation: () => ({ setOptions: mocks.setOptions }),
  useLocalSearchParams: () => mocks.params,
  useFocusEffect: (effect: () => (() => void) | undefined) =>
    useEffect(() => (mocks.focused ? effect() : undefined), [effect, mocks.focused]),
}));
vi.mock("react-native", () => {
  const view = ({
    children,
    accessibilityLabel,
    accessibilityRole,
    accessibilityValue,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityValue?: { text: string };
  }) =>
    createElement(
      "div",
      {
        "aria-label": accessibilityLabel,
        role: accessibilityRole,
        "aria-valuetext": accessibilityValue?.text,
      },
      children,
    );
  return {
    AccessibilityInfo: { announceForAccessibility: mocks.announce },
    ActivityIndicator: () => createElement("i", { "data-loading": true }),
    Platform: {
      get OS() {
        return mocks.platform;
      },
    },
    Keyboard: { dismiss: mocks.dismissKeyboard },
    Alert: { alert: mocks.alert, prompt: mocks.prompt },
    Linking: { openURL: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    ScrollView: view,
    View: view,
    Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children),
    TextInput: ({
      value,
      onChangeText,
      accessibilityLabel,
      placeholder,
    }: {
      value: string;
      onChangeText: (text: string) => void;
      accessibilityLabel?: string;
      placeholder?: string;
    }) =>
      createElement("input", {
        value,
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
        "aria-label": accessibilityLabel,
        placeholder,
      }),
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessibilityValue,
      accessibilityRole,
    }: {
      accessibilityRole?: string;
      children?: ReactNode;
      onPress: () => void;
      accessibilityLabel?: string;
      accessibilityValue?: { text: string };
    }) =>
      createElement(
        "button",
        {
          type: "button",
          role: accessibilityRole,
          onClick: onPress,
          "aria-label": accessibilityLabel,
          "aria-valuetext": accessibilityValue?.text,
        },
        children,
      ),
    SectionList: ({
      ref,
      onViewableItemsChanged,
      ...props
    }: {
      ref: Ref<{
        scrollToLocation: typeof mocks.scrollToLocation;
        getScrollResponder: () => { scrollTo: typeof mocks.scrollTo };
      }>;
      onViewableItemsChanged: (info: {
        viewableItems: { index: number; item: { key: string } }[];
      }) => void;
      onScrollToIndexFailed: (info: { averageItemLength: number; index: number }) => void;
      onScrollBeginDrag: () => void;
      sections: { key: string; heading?: string; data: { key: string }[] }[];
      renderItem: (info: {
        item: { key: string };
        index: number;
        section: { data: { key: string }[] };
      }) => ReactNode;
      renderSectionHeader: (info: { section: { heading?: string } }) => ReactNode;
      keyExtractor: (item: { key: string }) => string;
      ListEmptyComponent: ReactNode;
      ListHeaderComponent?: ReactNode;
      automaticallyAdjustKeyboardInsets: boolean;
      contentContainerStyle: unknown;
      contentInsetAdjustmentBehavior: string;
    }) => {
      const {
        sections,
        renderItem,
        renderSectionHeader,
        keyExtractor,
        ListEmptyComponent,
        ListHeaderComponent,
      } = props;
      useImperativeHandle(
        ref,
        () => ({
          scrollToLocation: mocks.scrollToLocation,
          getScrollResponder: () => ({ scrollTo: mocks.scrollTo }),
        }),
        [],
      );
      useEffect(() => {
        if (mocks.reportVisibleRows)
          onViewableItemsChanged({
            viewableItems: sections
              .flatMap((section) => section.data.map((item, index) => ({ index, item })))
              .slice(0, 4),
          });
      }, [sections, onViewableItemsChanged]);
      mocks.listProps = { ...props, onViewableItemsChanged };
      return createElement(
        "ul",
        {},
        ListHeaderComponent,
        sections.length
          ? sections.map((section) =>
              createElement(
                "section",
                { key: section.key },
                renderSectionHeader({ section }),
                section.data.map((item, index) =>
                  createElement(
                    "li",
                    { key: keyExtractor(item) },
                    renderItem({ item, index, section }),
                  ),
                ),
              ),
            )
          : ListEmptyComponent,
      );
    },
  };
});
vi.mock("./native", () => ({
  native: new Proxy({}, { get: (_target, name) => String(name) }),
  useMobileTokens: () => ({ mutedForeground: "muted", foreground: "ink", destructive: "error" }),
  useResolvedAppearance: () => "light",
  useThemedStyles: (createStyles: () => unknown) => createStyles(),
}));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string | number>) =>
    text.replace(/\{(\w+)\}/g, (match, key: string) => String(values?.[key] ?? match));
  return { t, useI18n: () => ({ t }) };
});
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({
    label,
    footer,
    children,
  }: {
    label?: string;
    footer?: string;
    children: ReactNode;
  }) =>
    createElement(
      "section",
      { "aria-label": label },
      createElement("header", {}, label),
      children,
      footer,
    ),
  SettingsLabel: ({ children }: { children: ReactNode }) => createElement("h2", {}, children),
  SettingsFooter: ({ children }: { children: ReactNode }) => createElement("span", {}, children),
  SettingsRow: ({
    title,
    detail,
    accessibilityState,
    onPress,
    trailing,
    value,
    accessibilityLabel,
    accessibilityHint,
    accessibilityValue,
    disabled,
    chevron,
    accessibilityActions,
    onAccessibilityAction,
    leading,
  }: {
    leading?: ReactNode;
    accessibilityActions?: { name: string; label: string }[];
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
    disabled?: boolean;
    chevron?: "right" | "down";
    value?: string;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityValue?: { text: string };
    title: string;
    detail?: string;
    accessibilityState?: { selected?: boolean; expanded?: boolean };
    onPress: () => void;
    trailing: ReactNode;
  }) => {
    if (onAccessibilityAction) mocks.rowAccessibilityActions.set(title, onAccessibilityAction);
    return createElement(
      "button",
      {
        "data-accessibility-actions": accessibilityActions?.map((action) => action.label).join(),
        type: "button",
        "aria-label": accessibilityLabel ?? title,
        "aria-description": accessibilityHint,
        "data-settings-row": true,
        "data-chevron": chevron,
        "aria-expanded": accessibilityState?.expanded,
        disabled,
        "aria-valuetext": accessibilityValue?.text,
        "aria-selected": accessibilityState?.selected,
        onClick: onPress,
      },
      leading,
      title,
      value,
      detail ? createElement("small", {}, detail) : null,
      trailing,
    );
  },
}));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("./bot-avatar-edit", () => ({
  avatarColor: (value: string) => value,
  avatarShape: () => null,
  isAvatarPhoto: () => false,
  withAvatarColor: (_value: string, color: string) => color,
  withAvatarShape: (value: string) => value,
}));
vi.mock("../components/computer-mode-picker", () => ({ ComputerModePicker: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
    prominence = "primary",
    variant,
    fill,
    style,
  }: {
    variant?: string;
    fill?: boolean;
    style?: CSSProperties;
    label: string;
    onPress: () => void;
    disabled?: boolean;
    prominence?: string;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        onClick: onPress,
        disabled,
        "data-prominence": prominence,
        "data-variant": variant,
        "data-fill": fill ?? (prominence === "primary" || prominence === "destructive"),
        style,
      },
      label,
    ),
}));
vi.mock("../components/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("../components/row-accessories", () => ({
  Chevron: () => null,
  Checkmark: () => createElement("i", { "data-checkmark": true }),
}));
vi.mock("../components/text-only-mark", () => ({
  TextOnlyMark: () => createElement("i", { "data-text-only": true }),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    title,
    actions,
    onPressAction,
    children,
  }: {
    title: string;
    actions: { id: string; title: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children: ReactNode;
  }) => {
    mocks.menus.set(title, { actions, onPressAction });
    return createElement("section", { "data-menu": title }, children);
  },
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.reportVisibleRows = true;
  mocks.headerInset = 0;
  mocks.focused = true;
  mocks.platform = "ios";
  mocks.connected = true;
  mocks.serverCredentials = false;
  mocks.catalogEmpty = false;
  mocks.extraProviders = false;
  mocks.gateway = false;
  mocks.workers = false;
  mocks.savedMaxTokens = undefined;
  mocks.savedAccountId = "account-fixture";
  mocks.savedGatewayId = "gateway-fixture";
  mocks.vendorLabels = false;
  mocks.subscriptionSignIn = false;
  mocks.secondConnection = false;
  mocks.backups = [];
  mocks.primary = null;
  mocks.rpc.mockReset();
  mocks.menus.clear();
  mocks.rowAccessibilityActions.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat settings model row", () => {
  const render = async () => {
    await act(async () => root.render(<BotSettingsScreen />));
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Advanced"]')!.click());
  };

  it("opens the searchable model list when there are too many models for a menu", async () => {
    mocks.params = { botId: "bot-fixture" };
    await render();
    expect(container.querySelector('[data-menu="Model"]')).toBeNull();
    const row = container.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
    expect(row?.getAttribute("aria-valuetext")).toBe("Space default (Model 1)");
    act(() => row!.click());
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith({
      pathname: "/bot-model",
      params: { botId: "bot-fixture", value: "" },
    });
  });

  it("stages the model the list hands back until Save", async () => {
    mocks.params = { botId: "bot-fixture" };
    await render();
    mocks.params = { botId: "bot-fixture", model: "openrouter::vendor/model-3" };
    await act(async () => root.render(<BotSettingsScreen />));
    expect(mocks.setParams).toHaveBeenCalledWith({ model: undefined });
    const row = container.querySelector('button[aria-label="Model"]');
    expect(row?.getAttribute("aria-valuetext")).toBe("Model 3 (OpenRouter)");
    expect(mocks.update).not.toHaveBeenCalled();
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    );
    await act(async () => save!.click());
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ modelProvider: "openrouter", modelId: "vendor/model-3" }),
    );
  });
});

describe("chat model list", () => {
  const search = (text: string) =>
    act(() => {
      const options = mocks.setOptions.mock.lastCall![0];
      options.headerSearchBarOptions.onChangeText({ nativeEvent: { text } });
    });
  const rows = () => [...container.querySelectorAll("li button")];

  it("checks the current model, filters by name or id, and returns the pick", async () => {
    mocks.params = { botId: "bot-fixture", value: "openrouter::vendor/model-2" };
    await act(async () => root.render(<BotModelScreen />));
    expect(rows()).toHaveLength(12);
    expect(mocks.setOptions.mock.lastCall![0].headerSearchBarOptions).toMatchObject({
      hideNavigationBar: false,
    });
    expect(mocks.listProps).toMatchObject({
      automaticallyAdjustKeyboardInsets: true,
      contentInsetAdjustmentBehavior: "automatic",
      contentContainerStyle: expect.arrayContaining([
        expect.objectContaining({ paddingBottom: 106 }),
      ]),
    });
    expect(container.querySelectorAll("h2")).toHaveLength(1);
    expect(container.querySelector("h2")?.textContent).toBe("OpenRouter");
    expect(rows()[0]?.querySelector("small")?.textContent).toBe("Model 1");
    expect(rows()[0]!.textContent).toBe("Space defaultModel 1");
    const checked = rows().filter((row) => row.getAttribute("aria-selected") === "true");
    expect(checked.map((row) => row.textContent)).toEqual(["Model 2"]);
    expect(checked[0]!.querySelector("[data-checkmark]")).not.toBeNull();

    search("MODEL 1");
    expect(rows().map((row) => row.textContent)).toEqual([
      "Space defaultModel 1",
      "Model 1",
      "Model 10",
      "Model 11",
    ]);
    search("vendor/model-7");
    expect(rows().map((row) => row.textContent)).toEqual(["Model 7"]);

    act(() => (rows()[0] as HTMLButtonElement).click());
    expect(mocks.dismissTo).toHaveBeenCalledExactlyOnceWith({
      pathname: "/bot-settings",
      params: { botId: "bot-fixture", model: "openrouter::vendor/model-7" },
    });
  });

  it("remounts the list only when the search query changes", async () => {
    mocks.params = { botId: "bot-fixture", value: "" };
    await act(async () => root.render(<BotModelScreen />));
    const initialList = container.querySelector("ul");
    expect(initialList).not.toBeNull();

    search("vendor/model-7");
    const filteredList = container.querySelector("ul");
    expect(filteredList).not.toBe(initialList);
    search("vendor/model-7");
    expect(container.querySelector("ul")).toBe(filteredList);
    search("no such model");
    const emptyList = container.querySelector("ul");
    expect(emptyList).not.toBe(filteredList);
    search("no such model");
    expect(container.querySelector("ul")).toBe(emptyList);
    search("vendor/model-2");
    const nextList = container.querySelector("ul");
    expect(nextList).not.toBe(emptyList);
    act(() => mocks.setOptions.mock.lastCall![0].headerSearchBarOptions.onCancelButtonPress());
    expect(container.querySelector("ul")).not.toBe(nextList);
    expect(rows()).toHaveLength(12);
  });

  it("says when nothing matches", async () => {
    mocks.params = { botId: "bot-fixture", value: "" };
    await act(async () => root.render(<BotModelScreen />));
    search("no such model");
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toBe("No matching models");
    expect(mocks.announce).toHaveBeenCalledExactlyOnceWith("No matching models");
  });
});

// Keep the base screen mounted as the native stack does, and simulate blur/focus on push/back.
function SettingsStackFixture({ base }: { base: "models" | "connection" }) {
  return (
    <>
      <div hidden={!mocks.focused}>{base === "models" ? <Models /> : <ModelConnection />}</div>
      {!mocks.focused ? <SettingsModelPickerScreen key={mocks.params.requestId} /> : null}
    </>
  );
}

function modelRow() {
  return container.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!;
}

async function renderStack(base: "models" | "connection", params: Record<string, string> = {}) {
  mocks.params = params;
  mocks.push.mockImplementation(({ params }: { params: Record<string, string> }) => {
    mocks.params = params;
    mocks.focused = false;
    root.render(<SettingsStackFixture base={base} />);
  });
  mocks.back.mockImplementation(() => {
    mocks.focused = true;
    mocks.params = params;
    root.render(<SettingsStackFixture base={base} />);
  });
  await act(async () => root.render(<SettingsStackFixture base={base} />));
}

const renderModels = () => renderStack("models");

/** Opens the connect or manage screen the model list would push for one provider. */
async function renderConnection(request: Partial<ModelConnectionRequest> = {}) {
  const requestId = openModelConnection({
    provider: mocks.gateway
      ? "cloudflare-ai-gateway"
      : mocks.workers
        ? "cloudflare-workers-ai"
        : "openrouter",
    credentialId: mocks.connected ? CREDENTIAL_ID : null,
    makeDefault: false,
    target: { scope: "account" },
    ...request,
  });
  await renderStack("connection", { requestId });
}

function searchModels(text: string) {
  act(() =>
    mocks.setOptions.mock.calls
      .findLast(([options]) => options.headerSearchBarOptions)![0]
      .headerSearchBarOptions.onChangeText({
        nativeEvent: { text },
      }),
  );
}

function pickerRows() {
  return [...container.querySelectorAll<HTMLButtonElement>("li button")];
}

function buttonWithText(text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === text,
  );
}

function editField(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("provider connection screen", () => {
  it("connects a provider with only its connection controls", async () => {
    mocks.connected = false;
    await renderConnection({ makeDefault: true });
    expect(mocks.setOptions).toHaveBeenCalledWith({ title: "OpenRouter" });
    expect(container.querySelector('button[aria-label="Provider"]')).toBeNull();
    expect(modelRow()).toBeNull();
    expect(container.querySelector('button[aria-label="Thinking"]')).toBeNull();
    expect(buttonWithText("Advanced")).toBeUndefined();
    expect(container.querySelector('input[aria-label="Maximum output tokens"]')).toBeNull();
    expect(buttonWithText("Connect API key")?.dataset.prominence).toBe("primary");
    expect(buttonWithText("Connect API key")?.disabled).toBe(true);
    expect(buttonWithText("Disconnect")).toBeUndefined();
  });

  it("manages a connected provider without choosing its model again", async () => {
    await renderConnection();
    expect(modelRow()).toBeNull();
    expect(container.querySelector('button[aria-label="Thinking"]')).toBeNull();
    expect(container.textContent).not.toContain("Use this model");
    const disconnect = buttonWithText("Disconnect")!;
    expect(disconnect.dataset.prominence).toBe("destructive");
    expect(disconnect.dataset.variant).toBe("text");
    expect(disconnect.parentElement!.textContent).toBe("ConnectedDisconnect");
    const keySection = buttonWithText("Replace API key")!.parentElement!;
    expect(keySection.firstElementChild?.textContent).toBe("API key");
    expect(buttonWithText("Replace API key")?.dataset.prominence).toBe("secondary");
    const advanced = buttonWithText("Advanced")!;
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    act(() => advanced.click());
    expect(advanced.getAttribute("aria-expanded")).toBe("true");
    expect(advanced.dataset.chevron).toBe("down");
  });

  it("reveals only the own-key controls behind server credentials", async () => {
    mocks.connected = false;
    mocks.serverCredentials = true;
    await renderConnection();
    expect(buttonWithText("Connect API key")).toBeUndefined();
    act(() => buttonWithText("Use your own key")!.click());
    expect(buttonWithText("Connect API key")).toBeDefined();
    expect(modelRow()).toBeNull();
    expect(buttonWithText("Disconnect")).toBeUndefined();
  });

  it("continues in the screen the slot hands back after connecting", async () => {
    mocks.connected = false;
    const onConnected = vi.fn(async () => ({
      pathname: "/model-picker" as const,
      params: { requestId: "picker-fixture" },
    }));
    await renderConnection({ onConnected });
    editField("API key", "fixture-key");
    await act(async () => buttonWithText("Connect API key")!.click());
    expect(mocks.rpc).toHaveBeenCalledWith(
      "models/connect",
      expect.objectContaining({
        provider: "openrouter",
        apiKey: "fixture-key",
        makeDefault: false,
      }),
    );
    expect(onConnected).toHaveBeenCalledWith({
      provider: "openrouter",
      modelId: "vendor/model-1",
      credentialId: CREDENTIAL_ID,
    });
    expect(mocks.replace).toHaveBeenCalledWith({
      pathname: "/model-picker",
      params: { requestId: "picker-fixture" },
    });
    expect(mocks.back).not.toHaveBeenCalled();
  });

  it("returns to the list when there is nothing to pick after connecting", async () => {
    mocks.connected = false;
    await renderConnection({ onConnected: async () => undefined });
    editField("API key", "fixture-key");
    await act(async () => buttonWithText("Connect API key")!.click());
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.back).toHaveBeenCalledOnce();
  });

  it("aborts pending subscription sign-in when the screen unmounts", async () => {
    mocks.connected = false;
    mocks.subscriptionSignIn = true;
    let completeSignIn!: (result: { status: "ready" }) => void;
    mocks.completeOAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        completeSignIn = resolve;
      }),
    );
    await renderConnection({ makeDefault: true });
    await act(async () => buttonWithText("Sign in")!.click());
    expect(mocks.rpc).toHaveBeenCalledWith(
      "models/beginOAuth",
      expect.objectContaining({ provider: "openrouter", makeDefault: true }),
    );
    const signal = mocks.completeOAuth.mock.lastCall![0] as AbortSignal;
    expect(signal.aborted).toBe(false);
    act(() => root.render(null));
    expect(signal.aborted).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("models/cancelOAuth", { loginId: "login-fixture" });
    await act(async () => completeSignIn({ status: "ready" }));
    expect(mocks.rpc).not.toHaveBeenCalledWith("models/finishOAuth", expect.anything());
  });
});

describe("provider connection limit saves", () => {
  it("shows Save under Advanced only when connected limits differ and saves without replacing a draft key", async () => {
    mocks.savedMaxTokens = 1000;
    await renderConnection();
    expect(buttonWithText("Replace API key")?.disabled).toBe(true);
    editField("API key", "1234567");
    expect(buttonWithText("Replace API key")?.disabled).toBe(true);
    editField("API key", "fixture-replacement-key");
    expect(buttonWithText("Replace API key")?.disabled).toBe(false);
    act(() => buttonWithText("Advanced")!.click());
    expect(buttonWithText("Save")).toBeUndefined();
    editField("Maximum output tokens", "2000");
    const save = buttonWithText("Save")!;
    expect(save.dataset.prominence).toBe("secondary");
    expect(save.previousElementSibling?.textContent).toContain("Maximum output tokens");
    editField("Maximum output tokens", "1000");
    expect(buttonWithText("Save")).toBeUndefined();
    editField("Maximum output tokens", "2000");
    await act(async () => buttonWithText("Save")!.click());
    expect(mocks.rpc).toHaveBeenCalledWith("models/connect", {
      provider: "openrouter",
      modelId: "vendor/model-1",
      makeDefault: false,
      scope: "account",
      maxTokens: 2000,
      label: "OpenRouter",
      // A save on a managed connection updates that connection only.
      credentialId: CREDENTIAL_ID,
    });
    expect(buttonWithText("Save")).toBeUndefined();
    const field = container.querySelector('input[aria-label="Maximum output tokens"]')!;
    expect(field.parentElement?.nextElementSibling?.textContent).toBe("Saved.");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="API key"]')!.value).toBe(
      "fixture-replacement-key",
    );
  });

  it("shows Saving while the Advanced save is pending", async () => {
    await renderConnection();
    act(() => buttonWithText("Advanced")!.click());
    editField("Maximum output tokens", "2000");
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mocks.rpc.mockImplementation((procedure) =>
      procedure === "models/connect" ? pending : undefined,
    );
    await act(async () => buttonWithText("Save")!.click());
    expect(buttonWithText("Saving…")?.disabled).toBe(true);
    expect(buttonWithText("Replace API key")?.disabled).toBe(true);
    await act(async () => finish());
    expect(buttonWithText("Saving…")).toBeUndefined();
    expect(container.textContent).toContain("Saved.");
  });

  it("keeps invalid limits feedback beside Advanced Save", async () => {
    await renderConnection();
    act(() => buttonWithText("Advanced")!.click());
    editField("Maximum output tokens", "0");
    await act(async () => buttonWithText("Save")!.click());
    expect(mocks.rpc.mock.calls.some(([procedure]) => procedure === "models/connect")).toBe(false);
    expect(buttonWithText("Save")?.nextElementSibling?.textContent).toContain(
      "Enter a whole number",
    );
  });

  it("edits a Workers AI account without a gateway or replacement key", async () => {
    mocks.workers = true;
    await renderConnection();
    expect(container.querySelector('input[aria-label="Account ID"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="Gateway ID"]')).toBeNull();
    editField("Account ID", "account-updated");
    await act(async () => buttonWithText("Save")!.click());
    expect(mocks.rpc).toHaveBeenCalledWith(
      "models/connect",
      expect.objectContaining({ provider: "cloudflare-workers-ai", accountId: "account-updated" }),
    );
    expect(
      mocks.rpc.mock.calls.find(([procedure]) => procedure === "models/connect")?.[1].apiKey,
    ).toBeUndefined();
  });

  it("enables the connected gateway Save only for changed routing and keeps feedback at that button", async () => {
    mocks.gateway = true;
    await renderConnection();
    expect(buttonWithText("Save")?.disabled).toBe(true);
    editField("Account ID", "account-updated");
    expect(buttonWithText("Save")?.disabled).toBe(false);
    await act(async () => buttonWithText("Save")!.click());
    expect(mocks.rpc).toHaveBeenCalledWith(
      "models/connect",
      expect.objectContaining({
        provider: "cloudflare-ai-gateway",
        accountId: "account-updated",
        gatewayId: "gateway-fixture",
      }),
    );
    expect(buttonWithText("Save")?.disabled).toBe(true);
    expect(
      container.querySelector('input[aria-label="API key"]')?.parentElement?.nextElementSibling
        ?.textContent,
    ).toBe("Saved.");
    editField("Gateway ID", "gateway-updated");
    expect(container.textContent).not.toContain("Saved.");
    editField("Gateway ID", "gateway-fixture");
    expect(buttonWithText("Save")?.disabled).toBe(true);
  });
});

describe("model role lists", () => {
  const model = (index: number) => ({ provider: "openrouter", modelId: `vendor/model-${index}` });
  /** A row picked from the list runs on the connection it was listed under. */
  const pinned = (index: number) => ({ ...model(index), credentialId: CREDENTIAL_ID });
  const section = (title: string) =>
    container.querySelector<HTMLElement>(`section[aria-label="${title}"]`)!;
  const rowTitles = (title = "Main model") =>
    [...section(title).querySelectorAll<HTMLElement>("[data-menu]")].map((row) => row.dataset.menu);
  const roleSaves = (role = "main") =>
    mocks.rpc.mock.calls
      .filter(
        ([procedure, input]) =>
          procedure === "models/setRole" && (input as { role: string }).role === role,
      )
      .map(([, input]) => {
        const {
          role: _role,
          expectedUserId: _user,
          scope: _scope,
          ...patch
        } = input as Record<string, unknown>;
        return patch;
      });
  const menuAction = async (title: string, action: string) =>
    act(async () => mocks.menus.get(title)!.onPressAction({ nativeEvent: { event: action } }));
  const rowButton = (title: string, name: string) =>
    [...section(title).querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes(name),
    )!;

  it("numbers the main model and its fallbacks, then offers Add fallback", async () => {
    mocks.primary = { ...model(1), thinkingLevel: "high" };
    mocks.backups = [model(2)];
    await renderModels();
    expect(container.textContent).not.toContain("Active model");
    expect(container.querySelector('button[aria-label="Provider"]')).toBeNull();
    const main = section("Main model");
    expect([...main.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "1Model 1OpenRouter, Thinking: High",
      "2Model 2OpenRouter",
      "Add fallback",
    ]);
    const approval = [...section("Approval model").querySelectorAll("button")];
    // A single row has no order to number.
    expect(approval.map((button) => button.textContent)).toEqual([
      "Model 1OpenRouter",
      "Add fallback",
    ]);
  });

  it("starts an empty main model with a row that asks for one", async () => {
    mocks.backups = [model(2)];
    await renderModels();
    expect(
      [...section("Main model").querySelectorAll("button")].map((button) => button.textContent),
    ).toEqual(["1Choose a model", "2Model 2OpenRouter", "Add fallback"]);
  });

  it("adds a fallback from the shared picker and saves it immediately", async () => {
    mocks.primary = model(1);
    await renderModels();
    act(() => rowButton("Main model", "Add fallback").click());
    expect(mocks.setOptions).toHaveBeenCalledWith({ title: "Add fallback" });
    expect(pickerRows()).toHaveLength(10);
    searchModels("vendor/model-4");
    await act(async () => pickerRows()[0]!.click());
    expect(rowTitles()).toEqual(["Model 1", "Model 4"]);
    // Keeping the first row leaves the main model and its effort alone.
    expect(roleSaves()).toEqual([{ backups: [pinned(4)] }]);
  });

  it("replaces a row in place from the picker", async () => {
    mocks.primary = model(1);
    mocks.backups = [model(2), model(3)];
    await renderModels();
    act(() => rowButton("Main model", "Model 2").click());
    expect(mocks.setOptions).toHaveBeenCalledWith({ title: "Main model" });
    expect(
      pickerRows()
        .filter((row) => row.getAttribute("aria-selected") === "true")
        .map((row) => row.textContent),
    ).toEqual(["Model 2"]);
    searchModels("vendor/model-5");
    await act(async () => pickerRows()[0]!.click());
    expect(roleSaves()).toEqual([{ backups: [pinned(5), model(3)] }]);
  });

  it("moves, removes and promotes with the full list", async () => {
    mocks.primary = model(1);
    mocks.backups = [model(2), model(3)];
    await renderModels();
    const ids = (title: string) => mocks.menus.get(title)!.actions.map((action) => action.id);
    expect(ids("Model 1")).toEqual(["thinking", "moveDown", "manage", "remove"]);
    expect(ids("Model 2")).toEqual(["moveUp", "moveDown", "manage", "remove"]);
    expect(ids("Model 3")).toEqual(["moveUp", "manage", "remove"]);
    expect(rowButton("Main model", "Model 1").getAttribute("data-accessibility-actions")).toBe(
      "Thinking: Default,Thinking: Low,Thinking: Medium,Thinking: High,Move down,Manage OpenRouter,Remove",
    );
    await menuAction("Model 3", "moveUp");
    expect(rowTitles()).toEqual(["Model 1", "Model 3", "Model 2"]);
    await act(async () =>
      mocks.rowAccessibilityActions.get("Model 1")!({ nativeEvent: { actionName: "remove" } }),
    );
    expect(rowTitles()).toEqual(["Model 3", "Model 2"]);
    expect(roleSaves()).toEqual([
      { backups: [model(3), model(2)] },
      { primary: model(3), backups: [model(2)] },
    ]);
  });

  it("lets any listed model lead the main list, including one the deployment runs", async () => {
    const managed = { provider: "anthropic", modelId: "claude-fixture" };
    mocks.primary = model(1);
    mocks.backups = [managed, model(3)];
    await renderModels();
    await menuAction("claude-fixture", "moveUp");
    expect(rowTitles()).toEqual(["claude-fixture", "Model 1", "Model 3"]);
    expect(roleSaves()).toEqual([{ primary: managed, backups: [model(1), model(3)] }]);
  });

  it("changes the main model's thinking with its role list", async () => {
    mocks.primary = { ...model(1), thinkingLevel: "high" };
    await renderModels();
    const thinking = mocks.menus.get("Model 1")!.actions[0]!;
    expect(thinking.subactions!.map((action) => [action.title, action.state])).toEqual([
      ["Default", "off"],
      ["Low", "off"],
      ["Medium", "off"],
      ["High", "on"],
    ]);
    await menuAction("Model 1", "thinking:medium");
    await menuAction("Model 1", "thinking:");
    expect(roleSaves()).toEqual([
      { primary: { ...model(1), thinkingLevel: "medium" } },
      { primary: { ...model(1), thinkingLevel: null } },
    ]);
    expect(mocks.rpc.mock.calls.some(([procedure]) => procedure === "models/setDefault")).toBe(
      false,
    );
  });

  it("opens the manage screen for a row's provider", async () => {
    mocks.primary = model(1);
    await renderModels();
    await menuAction("Model 1", "manage");
    expect(mocks.push).toHaveBeenLastCalledWith({
      pathname: "/model-connection",
      params: { requestId: expect.any(String) },
    });
    const request = modelConnectionRequest(mocks.params.requestId!)!;
    expect(request).toMatchObject({ provider: "openrouter", makeDefault: false });
    expect(request.onConnected).toBeUndefined();
  });

  it("lists providers to connect after the models and reopens the slot on that provider", async () => {
    mocks.primary = model(1);
    mocks.extraProviders = true;
    await renderModels();
    act(() => rowButton("Main model", "Model 1").click());
    expect([...container.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "OpenRouter",
    ]);
    const anthropic = pickerRows().find((row) => row.textContent?.startsWith("Anthropic"))!;
    expect(anthropic.textContent).toBe("AnthropicConnect");
    expect(anthropic.dataset.chevron).toBe("right");
    act(() => anthropic.click());
    expect(mocks.back).not.toHaveBeenCalled();
    const route = mocks.replace.mock.lastCall![0] as {
      pathname: string;
      params: { requestId: string };
    };
    expect(route.pathname).toBe("/model-connection");
    // Connecting from a chosen main model leaves it running until a model is picked.
    expect(modelConnectionRequest(route.params.requestId)).toMatchObject({
      provider: "anthropic",
      makeDefault: false,
    });

    act(() => mocks.back());
    act(() => rowButton("Main model", "Add fallback").click());
    act(() =>
      pickerRows()
        .find((row) => row.textContent?.startsWith("Google"))!
        .click(),
    );
    const fallback = modelConnectionRequest(
      (mocks.replace.mock.lastCall![0] as { params: { requestId: string } }).params.requestId,
    )!;
    expect(fallback).toMatchObject({ provider: "google", makeDefault: false });
    // Nothing joins the list until a model is picked from that provider.
    let next: unknown;
    await act(async () => {
      next = await fallback.onConnected!(pinned(1));
    });
    expect(roleSaves()).toEqual([]);
    const picker = modelPickerRequest(
      (next as { params: { requestId: string } }).params.requestId,
    )!;
    expect(picker.title).toBe("Add fallback");
    expect(picker.connectChoices).toBeUndefined();
    expect(picker.choices.map((choice) => choice.modelLabel)).toEqual(
      catalog.slice(1).map((entry) => entry.label),
    );
    await act(async () => picker.onSelect(picker.choices[2]!));
    expect(roleSaves()).toEqual([{ backups: [pinned(4)] }]);
  });

  it("reopens the empty main slot on the connection that became the main model", async () => {
    mocks.connected = false;
    await renderModels();
    act(() => rowButton("Main model", "Choose a model").click());
    act(() =>
      pickerRows()
        .find((row) => row.textContent?.startsWith("OpenRouter"))!
        .click(),
    );
    const request = modelConnectionRequest(
      (mocks.replace.mock.lastCall![0] as { params: { requestId: string } }).params.requestId,
    )!;
    expect(request.makeDefault).toBe(true);
    mocks.connected = true;
    mocks.primary = model(1);
    let next: unknown;
    await act(async () => {
      next = await request.onConnected!(pinned(1));
    });
    const picker = modelPickerRequest(
      (next as { params: { requestId: string } }).params.requestId,
    )!;
    expect(picker.selectedKey).toBe(
      JSON.stringify(["openrouter", "vendor/model-1", CREDENTIAL_ID]),
    );
    expect(picker.choices).toHaveLength(11);
    await act(async () => picker.onSelect(picker.choices[0]!));
    expect(roleSaves()).toEqual([]);
  });

  it("names the approval model's deployment default, sets one, and clears back to it", async () => {
    await renderModels();
    act(() => rowButton("Approval model", "Model 1").click());
    expect(mocks.setOptions).toHaveBeenCalledWith({ title: "Approval model" });
    expect(pickerRows()[0]?.textContent).toBe("Model 1");
    expect(pickerRows()[0]?.getAttribute("aria-selected")).toBe("true");
    searchModels("vendor/model-2");
    await act(async () => pickerRows()[0]!.click());
    expect(rowTitles("Approval model")).toEqual(["Model 2"]);
    act(() => rowButton("Approval model", "Model 2").click());
    await act(async () => pickerRows()[0]!.click());
    expect(roleSaves("approval")).toEqual([
      { primary: pinned(2), backups: [] },
      { primary: null, backups: [] },
    ]);
  });

  const holdFirstSave = () => {
    const first: { finish: () => void; fail: (error: Error) => void } = {
      finish: () => undefined,
      fail: () => undefined,
    };
    mocks.rpc.mockImplementation((procedure: string) =>
      procedure === "models/setRole" && roleSaves().length === 1
        ? new Promise<void>((resolve, reject) => {
            first.finish = resolve;
            first.fail = reject;
          })
        : undefined,
    );
    return first;
  };
  const mainLoads = () =>
    mocks.rpc.mock.calls.filter(
      ([procedure, input]) =>
        procedure === "models/role" && (input as { role: string })?.role === "main",
    ).length;
  const leaveModels = () => {
    act(() => root.unmount());
    root = createRoot(container);
  };

  it("runs saves one at a time in edit order", async () => {
    mocks.backups = [model(2), model(3), model(4)];
    await renderModels();
    const first = holdFirstSave();
    await menuAction("Model 2", "moveDown");
    await menuAction("Model 4", "remove");
    expect(roleSaves()).toEqual([{ backups: [model(3), model(2), model(4)] }]);
    await act(async () => first.finish());
    expect(roleSaves()).toEqual([
      { backups: [model(3), model(2), model(4)] },
      { backups: [model(3), model(2)] },
    ]);
    expect(rowTitles()).toEqual(["Model 3", "Model 2"]);
  });

  it("drops edits queued behind a failed save and reverts to the saved list", async () => {
    mocks.backups = [model(2), model(3), model(4)];
    await renderModels();
    const first = holdFirstSave();
    await menuAction("Model 2", "remove");
    await menuAction("Model 3", "remove");
    await act(async () => first.fail(new Error("Save failed")));
    expect(roleSaves()).toEqual([{ backups: [model(3), model(4)] }]);
    expect(rowTitles()).toEqual(["Model 2", "Model 3", "Model 4"]);
    expect(container.textContent).toContain("Save failed");
  });

  it("keeps saving accepted edits after leaving Models", async () => {
    mocks.backups = [model(2), model(3), model(4)];
    await renderModels();
    const first = holdFirstSave();
    await menuAction("Model 2", "remove");
    await menuAction("Model 3", "remove");
    leaveModels();
    await act(async () => first.finish());
    expect(roleSaves()).toEqual([{ backups: [model(3), model(4)] }, { backups: [model(4)] }]);
  });

  it("waits for pending saves before reloading the list", async () => {
    mocks.backups = [model(2), model(3)];
    await renderModels();
    const first = holdFirstSave();
    await menuAction("Model 2", "remove");
    leaveModels();
    mocks.backups = [model(3)];
    await renderModels();
    expect(mainLoads()).toBe(1);
    expect(container.textContent).not.toContain("Main model");
    await act(async () => first.finish());
    expect(mainLoads()).toBe(2);
    expect(rowTitles()).toEqual(["Model 3"]);
  });

  it("reverts to the saved list and announces the error when a save fails", async () => {
    mocks.backups = [model(2), model(3)];
    await renderModels();
    mocks.rpc.mockImplementation((procedure: string) =>
      procedure === "models/setRole" ? Promise.reject(new Error("Save failed")) : undefined,
    );
    await menuAction("Model 2", "remove");
    expect(roleSaves()).toEqual([{ backups: [model(3)] }]);
    expect(rowTitles()).toEqual(["Model 2", "Model 3"]);
    expect(container.textContent).toContain("Save failed");
    expect(mocks.announce).toHaveBeenCalledWith("Save failed");
  });

  it("hides the list while loading and offers no manage action without a connection", async () => {
    mocks.backups = new Promise(() => undefined);
    await renderModels();
    expect(container.textContent).not.toContain("Main model");
    leaveModels();
    mocks.backups = [model(2)];
    mocks.connected = false;
    await renderModels();
    expect(rowTitles()).toEqual(["Model 2"]);
    expect(mocks.menus.get("Model 2")!.actions.map((action) => action.id)).toEqual(["remove"]);
  });
});

describe("initial model picker scroll", () => {
  const choices = [
    { key: "first", label: "First", providerLabel: "First provider" },
    ...Array.from({ length: 30 }, (_, index) => ({
      key: `model-${index}`,
      label: `Model ${index}`,
      providerLabel: "Second provider",
    })),
  ];
  const render = async (selectedKey = "model-20") => {
    await act(async () =>
      root.render(
        <ModelPickerList choices={choices} selectedKey={selectedKey} onSelect={() => undefined} />,
      ),
    );
  };
  const report = () =>
    act(() =>
      (mocks.listProps.onViewableItemsChanged as (info: unknown) => void)({
        viewableItems: [{ index: 0, item: choices[0] }],
      }),
    );
  const fail = () =>
    act(() =>
      (mocks.listProps.onScrollToIndexFailed as (info: unknown) => void)({
        averageItemLength: 50,
        index: 24,
      }),
    );

  it("reveals a distant selection once after the first visible rows are laid out", async () => {
    await render();
    expect(mocks.scrollToLocation).toHaveBeenCalledExactlyOnceWith({
      sectionIndex: 1,
      itemIndex: 20,
      viewPosition: 0.5,
      animated: false,
    });
    report();
    await render("model-25");
    searchModels("Model");
    searchModels("");
    report();
    expect(mocks.scrollToLocation).toHaveBeenCalledOnce();
  });

  it("waits for an asynchronously loaded catalog", async () => {
    await act(async () =>
      root.render(
        <ModelPickerList choices={null} selectedKey="model-20" onSelect={() => undefined} />,
      ),
    );
    expect(mocks.scrollToLocation).not.toHaveBeenCalled();
    await render();
    expect(mocks.scrollToLocation).toHaveBeenCalledExactlyOnceWith({
      sectionIndex: 1,
      itemIndex: 20,
      viewPosition: 0.5,
      animated: false,
    });
  });

  it.each(["first", "model-0", "", "missing"])(
    "leaves the initial viewport alone for %s",
    async (key) => {
      await render(key);
      report();
      expect(mocks.scrollToLocation).not.toHaveBeenCalled();
    },
  );

  it.each(["query", "drag"])("cancels a pending reveal after %s", async (interaction) => {
    mocks.reportVisibleRows = false;
    await render();
    if (interaction === "query") {
      searchModels("Model");
      searchModels("");
    } else act(() => (mocks.listProps.onScrollBeginDrag as () => void)());
    report();
    expect(mocks.scrollToLocation).not.toHaveBeenCalled();
  });

  it("moves the render window and retries an unmeasured location only once", async () => {
    vi.useFakeTimers();
    await render();
    fail();
    expect(mocks.scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 1200, animated: false });
    act(() => vi.advanceTimersByTime(100));
    expect(mocks.scrollToLocation).toHaveBeenCalledTimes(2);
    fail();
    act(() => vi.advanceTimersByTime(100));
    expect(mocks.scrollToLocation).toHaveBeenCalledTimes(2);
  });

  it.each(["query", "drag", "unmount"])("cancels the retry after %s", async (interaction) => {
    vi.useFakeTimers();
    await render();
    fail();
    if (interaction === "query") searchModels("Model");
    else if (interaction === "drag") act(() => (mocks.listProps.onScrollBeginDrag as () => void)());
    else act(() => root.render(null));
    act(() => vi.advanceTimersByTime(100));
    expect(mocks.scrollToLocation).toHaveBeenCalledOnce();
  });

  it("reserves the floating header height without automatic double insets", async () => {
    mocks.headerInset = 104;
    await render("first");
    expect(mocks.listProps).toMatchObject({
      contentInsetAdjustmentBehavior: "never",
      contentContainerStyle: expect.arrayContaining([expect.objectContaining({ paddingTop: 120 })]),
    });
    searchModels("Model");
    expect(mocks.listProps.contentInsetAdjustmentBehavior).toBe("never");
  });
});

describe("shared model picker presentation", () => {
  const choices = [
    {
      key: "sonnet",
      label: "Anthropic: Claude Sonnet 4.5",
      modelLabel: "Anthropic: Claude Sonnet 4.5",
      providerLabel: "OpenRouter",
    },
    {
      key: "haiku",
      label: "Anthropic: Claude Haiku",
      modelLabel: "Anthropic: Claude Haiku",
      providerLabel: "OpenRouter",
    },
    {
      key: "gemini",
      label: "Google: Gemini",
      modelLabel: "Google: Gemini",
      providerLabel: "OpenRouter",
    },
    { key: "plain", label: "Plain model", modelLabel: "Plain model", providerLabel: "OpenRouter" },
  ];

  it("groups by vendor, strips titles, leaves ungrouped choices unheaded, filters and announces no matches", async () => {
    await act(async () =>
      root.render(
        <ModelPickerList
          choices={choices}
          selectedKey="sonnet"
          providerLabel="OpenRouter"
          onSelect={() => undefined}
        />,
      ),
    );
    expect([...container.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "Anthropic",
      "Google",
    ]);
    expect(pickerRows().map((row) => row.textContent)).toEqual([
      "Claude Sonnet 4.5",
      "Claude Haiku",
      "Gemini",
      "Plain model",
    ]);
    expect(pickerRows()[0]?.getAttribute("aria-selected")).toBe("true");
    searchModels("Anthropic");
    expect(pickerRows().map((row) => row.textContent)).toEqual([
      "Claude Sonnet 4.5",
      "Claude Haiku",
    ]);
    searchModels("unknown");
    expect(container.textContent).toBe("No matching models");
    expect(mocks.announce).toHaveBeenCalledWith("No matching models");
  });

  it("marks models that cannot read images and announces it", async () => {
    await act(async () =>
      root.render(
        <ModelPickerList
          choices={[
            { key: "text", label: "Text only", images: false },
            { key: "vision", label: "Vision", images: true },
            { key: "custom", label: "Custom" },
          ]}
          selectedKey="text"
          onSelect={() => undefined}
        />,
      ),
    );
    const [textOnly, vision, custom] = pickerRows();
    expect(textOnly?.querySelector("[data-text-only]")).not.toBeNull();
    expect(textOnly?.querySelector("[data-checkmark]")).not.toBeNull();
    expect(textOnly?.getAttribute("aria-description")).toBe("Can't read images");
    for (const row of [vision, custom]) {
      expect(row?.querySelector("[data-text-only]")).toBeNull();
      expect(row?.hasAttribute("aria-description")).toBe(false);
    }
  });

  it("renders loading and load errors", async () => {
    await act(async () =>
      root.render(<ModelPickerList choices={null} selectedKey="" onSelect={() => undefined} />),
    );
    expect(container.querySelector("[data-loading]")).not.toBeNull();
    await act(async () =>
      root.render(
        <ModelPickerList
          choices={null}
          selectedKey=""
          onSelect={() => undefined}
          error="Could not load model settings"
        />,
      ),
    );
    expect(container.textContent).toBe("Could not load model settings");
  });

  it("keeps the Android search input mounted while filtering", async () => {
    mocks.platform = "android";
    await act(async () =>
      root.render(
        <ModelPickerList choices={choices} selectedKey="sonnet" onSelect={() => undefined} />,
      ),
    );
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search"]')!;
    expect(input).not.toBeNull();
    expect(mocks.setOptions).not.toHaveBeenCalled();
    // React's controlled input setter plus input event exercises the Android fallback.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "Gemini");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(pickerRows().map((row) => row.textContent)).toEqual(["Gemini"]);
    expect(container.querySelector("input")).toBe(input);
  });
});

describe("several connections for one provider", () => {
  const model = (index: number, credentialId?: string) => ({
    provider: "openrouter",
    modelId: `vendor/model-${index}`,
    ...(credentialId ? { credentialId } : {}),
  });
  const section = (title: string) =>
    container.querySelector<HTMLElement>(`section[aria-label="${title}"]`)!;
  const roleSaves = () =>
    mocks.rpc.mock.calls
      .filter(([procedure]) => procedure === "models/setRole")
      .map(([, input]) => {
        const {
          role: _role,
          expectedUserId: _user,
          scope: _scope,
          ...patch
        } = input as Record<string, unknown>;
        return patch;
      });
  const lastRequest = (mock: typeof mocks.push) =>
    (mock.mock.lastCall![0] as { params: { requestId: string } }).params.requestId;
  beforeEach(() => {
    mocks.secondConnection = true;
  });

  it("lists each connection's models under its own name and saves the connection picked", async () => {
    mocks.primary = model(1, CREDENTIAL_ID);
    await renderModels();
    act(() =>
      [...section("Main model").querySelectorAll("button")]
        .find((button) => button.textContent === "Add fallback")!
        .click(),
    );
    expect([...container.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "OpenRouter",
      "OpenRouter (Work)",
    ]);
    // The running model is offered again on the other account.
    const picker = modelPickerRequest(mocks.params.requestId!)!;
    expect(picker.choices.filter((choice) => choice.modelId === "vendor/model-1")).toHaveLength(1);
    const work = picker.choices.find(
      (choice) =>
        choice.providerLabel === "OpenRouter (Work)" && choice.modelId === "vendor/model-1",
    )!;
    await act(async () => picker.onSelect(work));
    expect(roleSaves()).toEqual([{ backups: [model(1, WORK_CREDENTIAL_ID)] }]);
  });

  it("names a row's connection and manages that connection", async () => {
    mocks.primary = model(1, CREDENTIAL_ID);
    mocks.backups = [model(1, WORK_CREDENTIAL_ID)];
    await renderModels();
    expect(
      [...section("Main model").querySelectorAll("button")].map((button) => button.textContent),
    ).toEqual(["1Model 1OpenRouter", "2Model 1OpenRouter (Work)", "Add fallback"]);
    const menu = [...mocks.menus.entries()].filter(([title]) => title === "Model 1");
    expect(menu).toHaveLength(1);
    await act(async () =>
      mocks.menus.get("Model 1")!.onPressAction({ nativeEvent: { event: "manage" } }),
    );
    expect(modelConnectionRequest(lastRequest(mocks.push))).toMatchObject({
      provider: "openrouter",
      credentialId: WORK_CREDENTIAL_ID,
      makeDefault: false,
    });
  });

  it("lists every connection under Providers with rename, replace and disconnect", async () => {
    await renderModels();
    expect(
      [...section("Providers").querySelectorAll("button")].map((button) => button.textContent),
    ).toEqual(["OpenRouter", "OpenRouter (Work)", "Add provider"]);
    expect(mocks.menus.get("OpenRouter (Work)")!.actions.map((action) => action.title)).toEqual([
      "Rename",
      "Replace API key",
      "Disconnect",
    ]);

    await act(async () =>
      mocks.menus.get("OpenRouter (Work)")!.onPressAction({ nativeEvent: { event: "rename" } }),
    );
    const [, , buttons, , current] = mocks.prompt.mock.lastCall!;
    expect(current).toBe("Work");
    await act(async () => buttons[1].onPress(" Personal "));
    expect(mocks.rpc).toHaveBeenCalledWith("models/rename", {
      credentialId: WORK_CREDENTIAL_ID,
      label: "Personal",
    });

    await act(async () =>
      mocks.menus.get("OpenRouter (Work)")!.onPressAction({ nativeEvent: { event: "disconnect" } }),
    );
    const [title, , choices] = mocks.alert.mock.lastCall!;
    expect(title).toBe("Disconnect OpenRouter (Work)?");
    await act(async () => choices[1].onPress());
    expect(mocks.rpc).toHaveBeenCalledWith("models/disconnect", {
      provider: "openrouter",
      credentialId: WORK_CREDENTIAL_ID,
    });

    await act(async () =>
      mocks.menus.get("OpenRouter")!.onPressAction({ nativeEvent: { event: "manage" } }),
    );
    expect(modelConnectionRequest(lastRequest(mocks.push))).toMatchObject({
      credentialId: CREDENTIAL_ID,
    });
  });

  it("adds another connection for a connected provider without changing any list", async () => {
    await renderModels();
    act(() =>
      [...section("Providers").querySelectorAll("button")]
        .find((button) => button.textContent === "Add provider")!
        .click(),
    );
    expect(mocks.setOptions).toHaveBeenCalledWith({ title: "Add provider" });
    const openrouter = pickerRows().find((row) => row.textContent === "OpenRouter")!;
    act(() => openrouter.click());
    const request = modelConnectionRequest(lastRequest(mocks.replace))!;
    expect(request).toMatchObject({
      provider: "openrouter",
      credentialId: null,
      makeDefault: false,
    });
    expect(request.onConnected).toBeUndefined();
    expect(roleSaves()).toEqual([]);
  });
});

describe("connection screen targets", () => {
  it("adds a new connection and then keeps saving that one", async () => {
    mocks.connected = false;
    // The saved connection is listed when the screen reloads.
    mocks.rpc.mockImplementation((procedure: string) => {
      if (procedure === "models/connect") mocks.connected = true;
    });
    await renderConnection();
    editField("API key", "fixture-key");
    await act(async () => buttonWithText("Connect API key")!.click());
    expect(mocks.rpc).toHaveBeenCalledWith(
      "models/connect",
      expect.objectContaining({ apiKey: "fixture-key", credentialId: null }),
    );
    editField("API key", "fixture-key-2");
    await act(async () => buttonWithText("Replace API key")!.click());
    expect(mocks.rpc).toHaveBeenCalledWith(
      "models/connect",
      expect.objectContaining({ apiKey: "fixture-key-2", credentialId: CREDENTIAL_ID }),
    );
  });

  it("signs a new account in and disconnects only the managed connection", async () => {
    mocks.connected = false;
    mocks.subscriptionSignIn = true;
    mocks.completeOAuth.mockReturnValueOnce(new Promise(() => undefined));
    await renderConnection();
    await act(async () => buttonWithText("Sign in")!.click());
    expect(mocks.rpc).toHaveBeenCalledWith(
      "models/beginOAuth",
      expect.objectContaining({ provider: "openrouter", credentialId: null }),
    );
    act(() => root.render(null));

    mocks.connected = true;
    mocks.subscriptionSignIn = false;
    await renderConnection();
    act(() => buttonWithText("Disconnect")!.click());
    const [, , choices] = mocks.alert.mock.lastCall!;
    await act(async () => choices[1].onPress());
    expect(mocks.rpc).toHaveBeenCalledWith("models/disconnect", {
      provider: "openrouter",
      credentialId: CREDENTIAL_ID,
    });
  });
});
