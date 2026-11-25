// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type {
  MediaModelsView,
  ModelCatalogEntry,
  ModelCredential,
  ModelRoleView,
} from "@rakazo/contracts";

import { MAX_MODEL_CONTEXT_WINDOW, MAX_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Alert } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelConnection from "../../app/(settings)/model-connection";
import ModelSettingsScreen from "../../app/(settings)/model-settings";
import Models from "../../app/(settings)/models";
import { queryClient } from "../query/query";
import type { ModelConnectionRequest } from "./model-connection-request";
import {
  MODEL_CONNECT_TIMEOUT_MS,
  modelConnectionRequest,
  openModelConnection,
} from "./model-connection-request";
import { modelPickerRequest } from "./model-picker-selection";

const savedEndpoint = "https://models.example.test/v1";
const { push, back, replace, params, rpcCalls, saved, pinnedTo, focus } = vi.hoisted(() => ({
  focus: { on: true },
  /** What a request pinned to a Space carries: its server, its session and the Space's header. */
  pinnedTo: (spaceId: string) => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": spaceId },
  }),
  push: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
  params: {} as { requestId?: string; spaceId?: string; credentialId?: string; modelId?: string },
  rpcCalls: [] as [
    string,
    unknown,
    { requestContext?: { headers: object }; timeoutMs?: number }?,
  ][],
  saved: {
    baseUrl: "https://models.example.test/v1",
    hasKey: false,
    label: "Fixture",
    held: null as Promise<void> | null,
    failMe: false,
    failConnect: false as boolean | string,
    failProbe: undefined as string | undefined,
    showServerMessages: false,
    apiProtocol: undefined as string | undefined,
    reasoning: false,
    thinkingLevel: undefined as string | undefined,
    modelSettings: undefined as Record<string, object> | undefined,
    bots: [] as {
      id: string;
      name: string;
      modelProvider: string | null;
      modelId: string | null;
    }[],
    failBotList: false,
    roleCatalog: [] as ModelCatalogEntry[],
    roleSettings: { primary: null, backups: [] } as ModelRoleView,
    extraCredentials: [] as ModelCredential[],
    media: {
      image: { options: [], selected: null },
      video: { options: [], selected: null },
    } as MediaModelsView,
    // A failed save either keeps the bot's own model or finds it already cleared elsewhere.
    failBotUpdates: {} as Record<string, "kept" | "changed elsewhere">,
    needsModel: false,
    enabledModelIds: undefined as string[] | undefined,
    /** Procedures that answer with a failure. */
    failing: [] as string[],
  },
}));
const settingsRouter = { push, back, replace };

vi.mock("../platform/app-version", () => ({ analyticsAppVersion: () => undefined }));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../api/api", () => ({
  currentApiBase: () => "https://app.example.test",
  captureApiRequestContext: async (spaceId = "space-fixture") => pinnedTo(spaceId),
  selectedSpaceId: () => "space-fixture",
  rpc: async (
    procedure: string,
    input?: unknown,
    options?: { requestContext?: { headers: object }; timeoutMs?: number },
  ) => {
    rpcCalls.push([procedure, input, options]);
    if (saved.held) await saved.held;
    if (saved.failing.includes(procedure)) throw new Error("offline");
    if (saved.failMe && procedure === "me") throw new Error("offline");
    if (procedure === "me")
      return {
        userId: "user-fixture",
        spaceId: "space-fixture",
        defaultProvider: "openai-compatible",
        defaultModel: "model-fixture",
        needsModel: saved.needsModel,
      };
    if (procedure === "models/probeOpenAiCompatible" && saved.failProbe)
      throw new Error(saved.failProbe);
    if (procedure === "models/probeOpenAiCompatible")
      return { models: Array.from({ length: 11 }, (_, index) => `found-${index}`) };
    if (procedure === "models/role") return saved.roleSettings;
    if (procedure === "models/media") return saved.media;
    if (procedure === "models/setMedia") {
      const { role, credentialId, modelId } = input as {
        role: "image" | "video";
        credentialId: string;
        modelId: string;
      };
      saved.media = {
        ...saved.media,
        [role]: { ...saved.media[role], selected: { credentialId, modelId } },
      };
      return saved.media;
    }
    if (procedure === "models/setRole") {
      const {
        role: _role,
        scope: _scope,
        expectedUserId: _user,
        ...patch
      } = input as ModelRoleView & { role: string; scope: string; expectedUserId: string };
      saved.roleSettings = { ...saved.roleSettings, ...patch };
      return saved.roleSettings;
    }
    if (procedure === "bots/list") {
      if (saved.failBotList) throw new Error("offline");
      return saved.bots;
    }
    if (procedure === "bots/update") {
      const { botId } = input as { botId: string };
      const failure = saved.failBotUpdates[botId];
      if (failure !== "kept")
        saved.bots = saved.bots.map((bot) =>
          bot.id === botId ? { ...bot, modelProvider: null, modelId: null } : bot,
        );
      if (failure) throw new Error("offline");
      return {};
    }
    if (procedure === "models/connect") {
      if (saved.failConnect)
        throw new Error(
          typeof saved.failConnect === "string" ? saved.failConnect : "connection refused",
        );
      const form = input as {
        provider: string;
        baseUrl?: string;
        modelId?: string;
        maxTokens?: number;
      };
      return {
        id: "credential-new",
        provider: form.provider,
        label: "Saved fixture",
        hasKey: true,
        baseUrl: form.baseUrl,
        modelId: form.modelId,
        maxTokens: form.maxTokens,
        headerNames: ["x-session"],
      };
    }
    if (procedure === "models/forRole") return saved.roleCatalog;
    if (procedure === "models/list")
      return [
        {
          provider: "openai-compatible",
          id: "model-fixture",
          label: "Fixture",
          endpointPresets: [{ name: "Ollama Cloud", baseUrl: "https://ollama.com/v1" }],
        },
        { provider: "anthropic", providerName: "Anthropic", id: "claude-fixture", label: "Claude" },
        // Deployment-funded models still leave room for a personal key.
        {
          provider: "openrouter",
          providerName: "OpenRouter",
          id: "funded-fixture",
          label: "Funded",
          managed: true,
        },
      ];
    if (procedure === "models/credentials")
      return [
        ...saved.extraCredentials,
        {
          id: "credential-fixture",
          provider: "openai-compatible",
          modelId: "model-fixture",
          baseUrl: saved.baseUrl,
          hasKey: saved.hasKey,
          headerNames: ["x-session"],
          label: saved.label,
          ...(saved.apiProtocol ? { apiProtocol: saved.apiProtocol } : {}),
          ...(saved.reasoning ? { reasoning: true } : {}),
          ...(saved.thinkingLevel ? { thinkingLevel: saved.thinkingLevel } : {}),
          ...(saved.modelSettings ? { modelSettings: saved.modelSettings } : {}),
          ...(saved.enabledModelIds ? { enabledModelIds: saved.enabledModelIds } : {}),
        },
      ];
    return [];
  },
}));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("expo-router", () => ({
  useIsFocused: () => focus.on,
  useRouter: () => settingsRouter,
  useNavigation: () => ({ setOptions: vi.fn() }),
  useLocalSearchParams: () => params,
  useFocusEffect: (effect: () => (() => void) | undefined) =>
    useEffect(() => (focus.on ? effect() : undefined), [effect, focus.on]),
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    actions,
    onPressAction,
    title,
    children,
  }: {
    actions: { id: string; title: string; state?: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    title: string;
    children?: ReactNode;
  }) =>
    createElement(
      "div",
      { "aria-label": title },
      children,
      actions.map((action) =>
        createElement(
          "button",
          {
            key: action.id,
            type: "button",
            "aria-pressed": action.state === "on",
            onClick: () => onPressAction({ nativeEvent: { event: action.id } }),
          },
          action.title,
        ),
      ),
    ),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../native/native", () => ({
  native: new Proxy({}, { get: (_target, name) => String(name) }),
  useResolvedAppearance: () => "light",
  useMobileTokens: () => ({}),
  useThemedStyles: (createStyles: () => unknown) => createStyles(),
}));
vi.mock("../api/user-error", () => ({
  errorText: (error: unknown, fallback = "Something went wrong. Try again.") =>
    saved.showServerMessages && error instanceof Error ? error.message : fallback,
}));
vi.mock("../messages/message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
vi.mock("../../components/native/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    value,
    disabled,
    onValueChange,
  }: {
    accessibilityLabel: string;
    value: boolean;
    disabled: boolean;
    onValueChange: (value: boolean) => void;
  }) =>
    createElement("input", {
      type: "checkbox",
      "aria-label": accessibilityLabel,
      checked: value,
      disabled,
      onChange: () => onValueChange(!value),
    }),
}));
vi.mock("../../components/native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../../components/ui/row-accessories", () => ({
  Chevron: () => null,
  Checkmark: () => null,
}));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    label?: string;
    accessibilityLabel?: string;
    onPress: () => void;
    disabled?: boolean;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, disabled, "aria-label": accessibilityLabel },
      label,
    ),
}));
vi.mock("react-native", () => {
  const view = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return {
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    ActivityIndicator: () => createElement("span", {}, "Loading"),
    Alert: { alert: vi.fn() },
    Keyboard: { dismiss: vi.fn() },
    Platform: { OS: "ios" },
    PlatformColor: (name: string) => name,
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
    Linking: { openURL: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    ScrollView: view,
    View: view,
    Text: view,
    Pressable: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) =>
      createElement("button", { type: "button", onClick: onPress }, children),
    TextInput: ({
      accessibilityLabel,
      placeholder,
      value,
      onChangeText,
      secureTextEntry,
      maxLength,
    }: {
      accessibilityLabel?: string;
      placeholder?: string;
      value: string;
      onChangeText: (value: string) => void;
      secureTextEntry?: boolean;
      maxLength?: number;
    }) =>
      createElement("input", {
        "aria-label": accessibilityLabel,
        placeholder,
        value,
        maxLength,
        type: secureTextEntry ? "password" : "text",
        onInput: (event: { currentTarget: HTMLInputElement }) =>
          onChangeText(event.currentTarget.value),
      }),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
}));

// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

let container: HTMLDivElement;
let root: Root;

async function renderConnection(request: Partial<ModelConnectionRequest> = {}) {
  params.requestId = openModelConnection({
    provider: "openai-compatible",
    credentialId: "credential-fixture",
    makeDefault: false,
    target: { scope: "account" },
    ...request,
  });
  await act(async () => root.render(createElement(ModelConnection)));
}

// The shared level labels read the active catalog.
i18n.load("en", {});
i18n.activate("en");

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  rpcCalls.length = 0;
  saved.roleCatalog = [];
  saved.roleSettings = { primary: null, backups: [] };
  saved.extraCredentials = [];
  saved.media = { image: { options: [], selected: null }, video: { options: [], selected: null } };
  delete params.spaceId;
  back.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await renderConnection();
  const advanced = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Advanced",
  );
  expect(advanced).toBeDefined();
  await act(async () => advanced!.click());
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function field(label: string): HTMLInputElement | null {
  return container.querySelector(`input[aria-label="${label}"]`);
}
async function change(label: string, value: string) {
  const input = field(label)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function expectSavedHeader() {
  expect(field("Header name")?.value).toBe("x-session");
  expect(field("Header value")?.value).toBe("");
  expect(field("Header value")?.placeholder).toBe("••••••••");
  expect(field("Header value")?.type).toBe("password");
}

describe("mobile saved model headers", () => {
  it.each([
    " https://models.example.test/v1 ",
    "https://models.example.test/v1/",
    "https://models.example.test",
  ])("keeps masked saved headers for the equivalent endpoint %s", async (endpoint) => {
    expectSavedHeader();
    await change("OpenAI-compatible server URL", endpoint);
    expectSavedHeader();
  });

  it.each(["https://other.example.test/v1", "https://models.example.test/v2", "http://", ""])(
    "does not show saved headers at a changed or incomplete endpoint %s",
    async (endpoint) => {
      await change("OpenAI-compatible server URL", endpoint);
      expect(field("Header name")).toBeNull();
      const add = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Add header",
      )!;
      await act(async () => add.click());
      await change("Header name", "x-session");
      expect(field("Header value")?.placeholder).toBe("Header value");
      await change("OpenAI-compatible server URL", savedEndpoint);
      expectSavedHeader();
    },
  );
});

async function remount(render: () => Promise<void>) {
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
}

async function notConnectedChoices() {
  await remount(async () => {
    await act(async () => root.render(createElement(Models)));
  });
  const firstModel = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Choose a model",
  );
  expect(firstModel).toBeDefined();
  await act(async () => firstModel!.click());
  const route = push.mock.calls.at(-1)?.[0] as { params: { requestId: string } };
  return modelPickerRequest(route.params.requestId)!.connectChoices ?? [];
}

it("offers deployment-funded providers and Ollama Cloud once among providers to connect", async () => {
  expect((await notConnectedChoices()).map((choice) => choice.label)).toEqual([
    "Anthropic",
    "OpenRouter",
    "Ollama Cloud",
  ]);
});

it("does not offer Ollama Cloud again once it is the saved connection", async () => {
  saved.baseUrl = "https://ollama.com/";
  try {
    expect((await notConnectedChoices()).map((choice) => choice.label)).toEqual([
      "Anthropic",
      "OpenRouter",
    ]);
  } finally {
    saved.baseUrl = savedEndpoint;
  }
});

it("opens the Ollama preset through the compatible form with a visible key field", async () => {
  await remount(() => renderConnection({ baseUrl: "https://ollama.com/v1", credentialId: null }));
  expect(field("OpenAI-compatible server URL")).toBeNull();
  expect(field("API key")?.placeholder).toBe("");
  expect(field("API key")?.type).toBe("password");
  expect(
    [...container.querySelectorAll("button")].filter((button) =>
      ["Setup help", "API key"].includes(button.textContent ?? ""),
    ),
  ).toHaveLength(0);
});

it("keeps a pasted hosted URL editable and requires its key", async () => {
  await remount(() => renderConnection({ credentialId: null }));
  await change("OpenAI-compatible server URL", "https://ollama.com");
  await change("Model id", "fixture-model");
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  );
  expect(field("OpenAI-compatible server URL")?.value).toBe("https://ollama.com");
  expect(field("API key")).not.toBeNull();
  expect(save?.disabled).toBe(true);
  await change("API key", "fake-fixture-key");
  expect(save?.disabled).toBe(false);
});

it("hands a connected model back to the slot that asked for it", async () => {
  const onConnected = vi.fn(async () => undefined);
  await remount(() => renderConnection({ makeDefault: true, onConnected }));
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  )!;
  await act(async () => save.click());
  expect(rpcCalls.find(([procedure]) => procedure === "models/connect")?.[1]).toMatchObject({
    provider: "openai-compatible",
    modelId: "model-fixture",
    makeDefault: true,
    scope: "account",
  });
  expect(onConnected).toHaveBeenCalledWith({
    provider: "openai-compatible",
    modelId: "model-fixture",
    credentialId: "credential-new",
  });
  expect(back).toHaveBeenCalledOnce();
});

describe("a Space's model override", () => {
  const otherSpace = pinnedTo("space-other");

  it("edits that Space's lists in that Space and leaves connections to the account", async () => {
    params.spaceId = "space-other";
    await notConnectedChoices();
    expect(rpcCalls).toContainEqual([
      "models/role",
      { role: "main", expectedUserId: "user-fixture", scope: "space" },
      { requestContext: otherSpace },
    ]);
    expect(container.textContent).not.toContain("Add provider");
    const picker = modelPickerRequest(
      (push.mock.calls.at(-1)![0] as { params: { requestId: string } }).params.requestId,
    )!;
    const connect = picker.continueTo?.(picker.connectChoices![0]!) as unknown as {
      params: { requestId: string };
    };
    expect(modelConnectionRequest(connect.params.requestId)?.target).toEqual({
      scope: "space",
      spaceId: "space-other",
    });
  });

  it("connects through that Space so a new main model lands in its override", async () => {
    const onConnected = vi.fn(async () => undefined);
    await remount(() =>
      renderConnection({
        makeDefault: true,
        target: { scope: "space", spaceId: "space-other" },
        onConnected,
      }),
    );
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    )!;
    await act(async () => save.click());
    const connect = rpcCalls.find(([procedure]) => procedure === "models/connect");
    expect(connect?.[1]).toMatchObject({ makeDefault: true, scope: "space" });
    expect(connect?.[2]).toEqual({
      requestContext: otherSpace,
      timeoutMs: MODEL_CONNECT_TIMEOUT_MS,
    });
  });

  it("moves that Space's bots onto the main model in that Space", async () => {
    params.spaceId = "space-other";
    saved.bots = [
      { id: "bot-own", name: "Archie", modelProvider: "anthropic", modelId: "claude-fixture" },
    ];
    try {
      await remount(async () => {
        await act(async () => root.render(createElement(Models)));
      });
      rpcCalls.length = 0;
      await switchToSpaceDefault("Switch 1 bot to the space default?");
      const sent = (procedure: string) => rpcCalls.find(([name]) => name === procedure)?.[2];
      expect(sent("bots/update")).toEqual({ requestContext: otherSpace });
      expect(sent("bots/list")).toMatchObject({ requestContext: otherSpace });
      expect(container.textContent).toContain("1 bot now uses the space default.");
    } finally {
      saved.bots = [];
    }
  });
});

async function switchToSpaceDefault(confirmTitle: string) {
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Use space default",
  );
  await act(async () => button!.click());
  expect(rpcCalls.some(([procedure]) => procedure === "bots/update")).toBe(false);
  const [title, , buttons] = vi.mocked(Alert.alert).mock.calls.at(-1)!;
  expect(title).toBe(confirmTitle);
  await act(async () => buttons!.find((choice) => choice.text === "Switch")!.onPress!());
}

it("moves bots off their own model onto the main model, keeping failed ones listed", async () => {
  const pinned = (id: string, name: string) => ({
    id,
    name,
    modelProvider: "anthropic",
    modelId: "claude-fixture",
  });
  saved.bots = [
    pinned("bot-archie", "Archie"),
    pinned("bot-basil", "Basil"),
    pinned("bot-nova", "Nova"),
    pinned("bot-inbox", "Inbox"),
    { id: "bot-default", name: "Scout", modelProvider: null, modelId: null },
  ];
  const renderModels = () =>
    remount(async () => {
      await act(async () => root.render(createElement(Models)));
    });
  try {
    // An unreadable bot list hides only the bot group.
    saved.failBotList = true;
    await renderModels();
    expect(container.textContent).toContain("Main model");
    expect(container.textContent).not.toContain("Bot models");
    expect(container.textContent).not.toContain("Could not load model settings");
    saved.failBotList = false;
    // Without a main model there is no default to move bots onto.
    saved.needsModel = true;
    await renderModels();
    expect(container.textContent).toContain("Main model");
    expect(container.textContent).not.toContain("Archie");
    saved.needsModel = false;
    await renderModels();
    expect(container.textContent).toContain(
      "4 bots have their own model: Archie, Basil, Nova, Inbox",
    );
    expect(container.textContent).not.toContain("Scout");

    saved.failBotUpdates = { "bot-inbox": "kept", "bot-nova": "changed elsewhere" };
    rpcCalls.length = 0;
    await switchToSpaceDefault("Switch 4 bots to the space default?");
    expect(container.textContent).toContain("2 bots now use the space default.");
    expect(container.textContent).toContain("Could not switch Inbox. Try again.");
    expect(container.textContent).toContain("1 bot has its own model: Inbox");
    expect(container.textContent).not.toMatch(/Archie|Basil|Nova/);

    saved.failBotUpdates = {};
    rpcCalls.length = 0;
    await switchToSpaceDefault("Switch 1 bot to the space default?");
    expect(rpcCalls.filter(([procedure]) => procedure === "bots/update")).toEqual([
      [
        "bots/update",
        { botId: "bot-inbox", modelProvider: null, modelId: null, thinkingLevel: null },
        { requestContext: pinnedTo("space-fixture") },
      ],
    ]);
    expect(container.textContent).toContain("1 bot now uses the space default.");
    expect(container.textContent).not.toContain("Could not switch");
    expect(container.textContent).not.toContain("Use space default");
  } finally {
    saved.bots = [];
    saved.failBotList = false;
    saved.failBotUpdates = {};
    saved.needsModel = false;
  }
});

const PROTOCOL_LABELS = ["Chat Completions", "Responses", "Anthropic Messages"] as const;

function protocolChoice(label: string) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === label)!;
}

function currentProtocol(): string | undefined {
  return PROTOCOL_LABELS.find(
    (label) => protocolChoice(label).getAttribute("aria-pressed") === "true",
  );
}

async function saveConnection() {
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  )!;
  await act(async () => save.click());
}

it("drops the saved model at another endpoint and restores it at the saved one", async () => {
  await remount(() => renderConnection());
  await change("OpenAI-compatible server URL", "https://other.example.test/v1");
  await saveConnection();
  expect(
    rpcCalls.some(
      ([procedure, input]) =>
        procedure === "models/connect" &&
        (input as { modelId?: string }).modelId === "model-fixture",
    ),
  ).toBe(false);
  await change("OpenAI-compatible server URL", `${savedEndpoint}/`);
  await saveConnection();
  expect(rpcCalls.find(([procedure]) => procedure === "models/connect")?.[1]).toMatchObject({
    modelId: "model-fixture",
  });
});

it("offers the wire protocol on the compatible form and sends the saved choice", async () => {
  saved.apiProtocol = "anthropic-messages";
  try {
    await remount(() => renderConnection());
    const advanced = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Advanced",
    );
    await act(async () => advanced!.click());
    expect(currentProtocol()).toBe("Anthropic Messages");
    await act(async () => protocolChoice("Responses").click());
    await saveConnection();
    expect(rpcCalls.find(([procedure]) => procedure === "models/connect")?.[1]).toMatchObject({
      provider: "openai-compatible",
      apiProtocol: "responses",
    });
  } finally {
    saved.apiProtocol = undefined;
  }
});

it("keeps the chosen protocol when the endpoint changes", async () => {
  saved.apiProtocol = "anthropic-messages";
  try {
    await remount(() => renderConnection());
    const advanced = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Advanced",
    );
    await act(async () => advanced!.click());
    await change("OpenAI-compatible server URL", "https://other.example.test/v1");
    expect(currentProtocol()).toBe("Anthropic Messages");
  } finally {
    saved.apiProtocol = undefined;
  }
});

it("offers no protocol choice on a catalog provider's connection", async () => {
  await remount(() => renderConnection({ provider: "anthropic", credentialId: null }));
  expect(PROTOCOL_LABELS.some((label) => container.textContent?.includes(label))).toBe(false);
});

it("lists the connection's models, each opening its settings", async () => {
  push.mockClear();
  const row = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("model-fixture"),
  );
  expect(row).toBeDefined();
  await act(async () => row!.click());
  expect(push).toHaveBeenCalledWith({
    pathname: "/model-settings",
    params: { credentialId: "credential-fixture", modelId: "model-fixture" },
  });
});

it("saves a model's own limits and capabilities from its Manage model screen", async () => {
  params.credentialId = "credential-fixture";
  params.modelId = "model-fixture";
  try {
    await remount(async () => {
      await act(async () => root.render(createElement(ModelSettingsScreen)));
    });
    expect(field("Maximum output tokens")?.maxLength).toBe(String(MAX_MODEL_MAX_TOKENS).length);
    expect(field("Context limit")?.maxLength).toBe(String(MAX_MODEL_CONTEXT_WINDOW).length);
    expect(field("Context limit")?.placeholder).toBe("262144");
    expect(field("Maximum images per request")).toBeNull();
    await act(async () => field("Supports images")!.click());
    expect(field("Maximum images per request")).not.toBeNull();
    await change("Maximum output tokens", "8192");
    await saveConnection();
    expect(rpcCalls.find(([procedure]) => procedure === "models/saveModelSettings")?.[1]).toEqual({
      credentialId: "credential-fixture",
      modelId: "model-fixture",
      settings: { maxTokens: 8192, images: true, reasoning: false },
    });
  } finally {
    delete params.credentialId;
    delete params.modelId;
  }
});

it("leaves a removed model's settings and preserves the selected Space", async () => {
  params.credentialId = "credential-fixture";
  params.modelId = "removed-model";
  params.spaceId = "space-override";
  replace.mockClear();
  try {
    await remount(async () => {
      await act(async () => root.render(createElement(ModelSettingsScreen)));
    });
    expect(replace).toHaveBeenCalledWith({
      pathname: "/models",
      params: { spaceId: "space-override" },
    });
    expect(field("Maximum output tokens")).toBeNull();
    expect(rpcCalls.some(([procedure]) => procedure === "models/saveModelSettings")).toBe(false);
  } finally {
    delete params.credentialId;
    delete params.modelId;
    delete params.spaceId;
  }
});

it("reads and saves a Space override's model settings in that Space", async () => {
  params.credentialId = "credential-fixture";
  params.modelId = "model-fixture";
  params.spaceId = "space-override";
  rpcCalls.length = 0;
  try {
    await remount(async () => {
      await act(async () => root.render(createElement(ModelSettingsScreen)));
    });
    await change("Maximum output tokens", "8192");
    await saveConnection();
    for (const procedure of ["models/credentials", "models/list", "models/saveModelSettings"])
      expect(
        rpcCalls.find(([called]) => called === procedure)?.[2]?.requestContext?.headers,
      ).toEqual({ "x-rakazo-space-id": "space-override" });
  } finally {
    delete params.credentialId;
    delete params.modelId;
    delete params.spaceId;
  }
});

it("resets a customized model to its defaults", async () => {
  params.credentialId = "credential-fixture";
  params.modelId = "model-fixture";
  saved.modelSettings = { "model-fixture": { maxTokens: 8192 } };
  try {
    await remount(async () => {
      await act(async () => root.render(createElement(ModelSettingsScreen)));
    });
    expect(field("Maximum output tokens")?.value).toBe("8192");
    const reset = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reset to defaults",
    );
    expect(reset).toBeDefined();
    await act(async () => reset!.click());
    expect(
      rpcCalls.findLast(([procedure]) => procedure === "models/saveModelSettings")?.[1],
    ).toEqual({ credentialId: "credential-fixture", modelId: "model-fixture", settings: {} });
  } finally {
    saved.modelSettings = undefined;
    delete params.credentialId;
    delete params.modelId;
  }
});

describe("a model's own settings", () => {
  const saves = () => rpcCalls.filter(([procedure]) => procedure === "models/saveModelSettings");
  const reads = () => rpcCalls.filter(([procedure]) => procedure === "models/credentials").length;
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === label);
  const show = () => act(async () => root.render(createElement(ModelSettingsScreen)));
  function hold() {
    const release = deferred();
    saved.held = release.promise;
    return async () => {
      saved.held = null;
      await act(async () => release.resolve());
    };
  }

  beforeEach(async () => {
    params.credentialId = "credential-fixture";
    params.modelId = "model-fixture";
    await remount(show);
  });
  afterEach(() => {
    delete params.credentialId;
    delete params.modelId;
    saved.held = null;
    saved.failing = [];
    saved.enabledModelIds = undefined;
    focus.on = true;
  });

  it("saves once for two taps in one tick, and holds Save until the settings are read again", async () => {
    await change("Maximum output tokens", "8192");
    const readsBefore = reads();
    const release = hold();
    await act(async () => {
      button("Save")!.click();
      button("Save")!.click();
    });
    expect(saves()).toHaveLength(1);
    expect(button("Saving…")?.disabled).toBe(true);
    saved.modelSettings = { "model-fixture": { maxTokens: 8192 } };
    try {
      await release();
      expect(saves()).toHaveLength(1);
      expect(reads()).toBe(readsBefore + 1);
      expect(container.textContent).toContain("Saved.");
      expect(field("Maximum output tokens")?.value).toBe("8192");
      // Nothing is left to save once the form shows what was read back.
      expect(button("Save")).toBeUndefined();
    } finally {
      saved.modelSettings = undefined;
    }
  });

  it("says the settings could not be read after a save, not that the save failed", async () => {
    await change("Maximum output tokens", "8192");
    saved.failing = ["models/credentials"];
    await saveConnection();
    expect(saves()).toHaveLength(1);
    expect(container.textContent).toContain("Could not load model settings");
    expect(container.textContent).not.toContain("Could not save model settings");
    expect(container.textContent).not.toContain("Saved.");
    // The edit stays, and Save is offered again.
    expect(field("Maximum output tokens")?.value).toBe("8192");
    expect(button("Save")?.disabled).toBe(false);
  });

  it("says so when the save fails, keeps the edit, and lets Save be tapped again", async () => {
    await change("Maximum output tokens", "8192");
    const readsBefore = reads();
    saved.failing = ["models/saveModelSettings"];
    await saveConnection();
    expect(container.textContent).toContain("Could not save model settings");
    expect(reads()).toBe(readsBefore);
    expect(field("Maximum output tokens")?.value).toBe("8192");
    saved.failing = [];
    await saveConnection();
    expect(saves()).toHaveLength(2);
    expect(container.textContent).toContain("Saved.");
  });

  it("starts another model from what is read for it, not from the last model's edits", async () => {
    saved.enabledModelIds = ["model-fixture", "model-other"];
    await remount(show);
    await change("Maximum output tokens", "8192");
    const release = hold();
    params.modelId = "model-other";
    await show();
    // Nothing to edit or save until this model's own read is back.
    expect(field("Maximum output tokens")).toBeNull();
    expect(button("Save")).toBeUndefined();
    await release();
    expect(field("Maximum output tokens")?.value).toBe("");
    expect(button("Save")).toBeUndefined();
  });

  it("does not carry one model's Saved notice over to the next model", async () => {
    saved.enabledModelIds = ["model-fixture", "model-other"];
    await remount(show);
    await change("Maximum output tokens", "8192");
    await saveConnection();
    expect(container.textContent).toContain("Saved.");
    params.modelId = "model-other";
    await show();
    expect(field("Maximum output tokens")).not.toBeNull();
    expect(container.textContent).not.toContain("Saved.");
  });

  it("reads the settings again on a later visit instead of showing the earlier copy", async () => {
    const release = hold();
    await remount(show);
    expect(field("Maximum output tokens")).toBeNull();
    saved.modelSettings = { "model-fixture": { maxTokens: 8192 } };
    try {
      await release();
      expect(field("Maximum output tokens")?.value).toBe("8192");
    } finally {
      saved.modelSettings = undefined;
    }
  });

  it("reads the settings again on return to the screen, and starts again from what is saved", async () => {
    await change("Maximum output tokens", "8192");
    const readsBefore = reads();
    focus.on = false;
    await show();
    expect(reads()).toBe(readsBefore);
    expect(field("Maximum output tokens")?.value).toBe("8192");
    focus.on = true;
    await show();
    expect(reads()).toBe(readsBefore + 1);
    expect(field("Maximum output tokens")?.value).toBe("");
  });
});

it("keeps the optional API key collapsible for generic compatible servers", async () => {
  const row = (name: string) =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === name)!;
  expect(field("API key")).toBeNull();
  await act(async () => row("API key").click());
  expect(field("API key")).not.toBeNull();
  await act(async () => row("API key").click());
  expect(field("API key")).toBeNull();
});

it("keeps Save enabled with a saved Ollama key and keeps the endpoint fixed", async () => {
  saved.baseUrl = "https://ollama.com/v1";
  saved.hasKey = true;
  try {
    await remount(() => renderConnection());
    expect(field("OpenAI-compatible server URL")).toBeNull();
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    );
    expect(save).toBeDefined();
    expect(save!.disabled).toBe(false);
  } finally {
    saved.baseUrl = savedEndpoint;
    saved.hasKey = false;
  }
});

it("paints a revisit from cache without a spinner and refreshes behind it", async () => {
  await remount(async () => {
    await act(async () => root.render(createElement(Models)));
  });
  expect(container.textContent).toContain("Fixture");
  const release = deferred();
  saved.held = release.promise;
  saved.label = "Renamed fixture";
  try {
    rpcCalls.length = 0;
    await remount(async () => {
      await act(async () => root.render(createElement(Models)));
    });
    expect(container.textContent).not.toContain("Loading");
    expect(container.textContent).not.toContain("Renamed fixture");
    expect(rpcCalls.map(([procedure]) => procedure)).toContain("models/credentials");

    await act(async () => release.resolve());
    expect(container.textContent).toContain("Renamed fixture");
  } finally {
    saved.held = null;
    saved.label = "Fixture";
  }
});

it("offers the image models the member's keys make and saves the one chosen", async () => {
  const option = (modelId: string, label: string) => ({
    credentialId: "key",
    modelId,
    label,
    provider: "lab",
    connectionLabel: "Work",
  });
  saved.media = {
    image: {
      options: [option("draw-2", "Draw 2"), option("draw-mini", "Draw Mini")],
      selected: { credentialId: "key", modelId: "draw-2" },
    },
    video: { options: [], selected: null },
  };
  await remount(async () => {
    await act(async () => root.render(createElement(Models)));
  });
  expect(container.textContent).not.toContain("Video model");
  const row = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Draw 2"),
  )!;
  await act(async () => row.click());
  const request = modelPickerRequest(
    (push.mock.calls.at(-1)![0] as { params: { requestId: string } }).params.requestId,
  )!;
  expect(request.title).toBe("Image model");
  expect(request.choices.map((choice) => choice.modelLabel)).toEqual(["Draw 2", "Draw Mini"]);
  await act(async () => request.onSelect(request.choices[1]!));
  expect(rpcCalls.find(([procedure]) => procedure === "models/setMedia")?.[1]).toEqual({
    role: "image",
    credentialId: "key",
    modelId: "draw-mini",
    scope: "account",
  });
  await vi.waitFor(() =>
    expect(
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Draw Mini"),
      ),
    ).toBe(true),
  );
});

it("offers a retry when the first load fails, then shows the model lists", async () => {
  queryClient.clear();
  saved.failMe = true;
  try {
    await remount(async () => {
      await act(async () => root.render(createElement(Models)));
    });
    expect(container.textContent).not.toContain("Add fallback");
    expect(container.textContent).toContain("Could not load model settings");
    saved.failMe = false;
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    await act(async () => retry!.click());
    expect(container.textContent).toContain("Choose a model");
    expect(container.textContent).not.toContain("Could not load model settings");
  } finally {
    saved.failMe = false;
  }
});

it("searches discovered models without losing the selected default", async () => {
  expect(field("Search")).toBeNull();
  await act(async () =>
    vi.waitFor(() =>
      expect(rpcCalls.some(([name]) => name === "models/probeOpenAiCompatible")).toBe(true),
    ),
  );
  const modelPicker = () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Model")!;
  await act(async () => modelPicker().click());
  expect(field("Search")).not.toBeNull();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "found-0")!
      .click(),
  );
  await act(async () => modelPicker().click());
  await act(async () => field("found-1")!.click());
  await change("Search", "found-10");
  expect(container.textContent).not.toContain("found-0");
  expect(container.textContent).toContain("found-10");
  await change("Search", "");
  expect(container.textContent).toContain("found-0");
  expect(field("found-0")?.checked).toBe(true);
  expect(field("found-1")?.checked).toBe(true);
});

describe("connection success with a failed refresh", () => {
  afterEach(() => {
    saved.failMe = false;
    saved.failConnect = false;
    saved.failProbe = undefined;
    saved.showServerMessages = false;
  });

  it("keeps a new saved connection and clears its key when refreshing fails", async () => {
    await remount(() => renderConnection({ credentialId: null, baseUrl: "https://ollama.com/v1" }));
    await change("API key", "synthetic-test-key");
    await change("Model id", "model-fixture");
    saved.failMe = true;
    await saveConnection();
    expect(container.textContent).not.toContain("Could not connect this provider");
    expect(container.textContent).toContain("Could not load model settings");
    expect(field("API key")?.value).toBe("");
    expect(field("API key")?.placeholder).toBe("Paste a replacement key");
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    )!;
    expect(save.disabled).toBe(false);
    await saveConnection();
    const connects = rpcCalls.filter(([procedure]) => procedure === "models/connect");
    expect(connects).toHaveLength(2);
    expect(connects[1]?.[1]).toMatchObject({ credentialId: "credential-new" });
    expect((connects[1]?.[1] as { apiKey?: string } | undefined)?.apiKey).toBeUndefined();
  });

  it("keeps a saved connection when the picker's follow-up read fails", async () => {
    const onConnected = vi.fn(async () => {
      throw new Error("credentials refresh failed");
    });
    await remount(() =>
      renderConnection({ credentialId: null, baseUrl: "https://ollama.com/v1", onConnected }),
    );
    await change("API key", "synthetic-test-key");
    await change("Model id", "model-fixture");
    await saveConnection();
    expect(onConnected).toHaveBeenCalledWith({
      provider: "openai-compatible",
      modelId: "model-fixture",
      credentialId: "credential-new",
    });
    expect(container.textContent).toContain("Could not load model settings");
    expect(container.textContent).not.toContain("Could not connect this provider");
    expect(field("API key")?.value).toBe("");
    expect(field("API key")?.placeholder).toBe("Paste a replacement key");
    expect(back).not.toHaveBeenCalled();
  });

  it("keeps the typed key and unsaved state when the connection itself fails", async () => {
    await remount(() => renderConnection({ credentialId: null, baseUrl: "https://ollama.com/v1" }));
    await change("API key", "synthetic-test-key");
    await change("Model id", "model-fixture");
    saved.failConnect = true;
    await saveConnection();
    expect(container.textContent).toContain("Could not connect this provider");
    expect(field("API key")?.value).toBe("synthetic-test-key");
    expect(field("API key")?.placeholder).not.toBe("Paste a replacement key");
  });

  it("hides the typed key when a failed connection's message repeats it", async () => {
    await remount(() => renderConnection({ credentialId: null, baseUrl: "https://ollama.com/v1" }));
    await change("API key", "synthetic-test-key");
    await change("Model id", "model-fixture");
    saved.failConnect = "The provider did not accept synthetic-test-key for this model.";
    saved.showServerMessages = true;
    await saveConnection();
    expect(container.textContent).toContain("The provider did not accept ••• for this model.");
    expect(container.textContent).not.toContain("synthetic-test-key");
  });

  it("hides the typed key when a failed model search's message repeats it", async () => {
    await remount(() => renderConnection({ credentialId: null, baseUrl: "https://ollama.com/v1" }));
    await change("API key", "synthetic-test-key");
    saved.failProbe = "The server refused the header value synthetic-test-key.";
    saved.showServerMessages = true;
    await act(async () =>
      vi.waitFor(() =>
        expect(rpcCalls.some(([name]) => name === "models/probeOpenAiCompatible")).toBe(true),
      ),
    );
    expect(container.textContent).toContain("The server refused the header value •••.");
    expect(container.textContent).not.toContain("synthetic-test-key");
  });
});

it("names a default the deployment pays for as included instead of by its provider", async () => {
  saved.roleSettings = {
    primary: null,
    backups: [],
    deploymentPrimary: { provider: "openrouter", modelId: "default-model" },
    deploymentIncluded: true,
  };
  await remount(async () => {
    await act(async () => root.render(createElement(Models)));
  });
  expect(container.textContent).toContain("Included");
});

it("keeps native picker credit and personal selections distinct for the same model", async () => {
  saved.roleSettings.deploymentPrimary = { provider: "openrouter", modelId: "default-model" };
  saved.roleCatalog = [
    {
      provider: "anthropic",
      providerName: "Anthropic",
      id: "model-example",
      label: "Example",
      billing: "",
      creditOfferingId: "offering-example",
    },
  ];
  saved.extraCredentials = [
    {
      id: "personal-example",
      provider: "anthropic",
      label: "Personal",
      hasKey: true,
      isDefault: false,
    },
  ];
  await remount(async () => {
    await act(async () => root.render(createElement(Models)));
  });
  const add = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Add fallback"),
  );
  await act(async () => add!.click());
  const request = modelPickerRequest(
    (push.mock.calls.at(-1)![0] as { params: { requestId: string } }).params.requestId,
  )!;
  const credit = request.choices.find((choice) => choice.providerLabel === "Rakazo credits")!;
  const personal = request.choices.find((choice) => choice.providerLabel?.includes("Personal"))!;
  expect(credit.key).not.toBe(personal.key);
  await act(async () => {
    request.onSelect(credit);
  });
  expect(saved.roleSettings.backups).toEqual([
    { provider: "anthropic", modelId: "model-example", creditOfferingId: "offering-example" },
  ]);
  await act(async () => {
    request.onSelect(personal);
  });
  expect(saved.roleSettings.backups).toContainEqual({
    provider: "anthropic",
    modelId: "model-example",
    credentialId: "personal-example",
  });
});
