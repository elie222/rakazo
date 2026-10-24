// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Models from "../app/(settings)/models";
import { modelPickerRequest, selectPickerModel } from "./model-picker-selection";

const savedEndpoint = "https://models.example.test/v1";
const { push, saved } = vi.hoisted(() => ({
  push: vi.fn(),
  saved: { baseUrl: "https://models.example.test/v1", hasKey: false },
}));

vi.mock("./api", () => ({
  captureApiRequestContext: async () => ({}),
  selectedSpaceId: () => "space-fixture",
  rpc: async (procedure: string) => {
    if (procedure === "me")
      return {
        userId: "user-fixture",
        spaceId: "space-fixture",
        defaultProvider: "openai-compatible",
        defaultModel: "model-fixture",
      };
    if (procedure === "models/list")
      return [{ provider: "openai-compatible", id: "model-fixture", label: "Fixture" }];
    if (procedure === "models/credentials")
      return [
        {
          id: "credential-fixture",
          provider: "openai-compatible",
          modelId: "model-fixture",
          baseUrl: saved.baseUrl,
          hasKey: saved.hasKey,
          headerNames: ["x-session"],
          label: "Fixture",
        },
      ];
    return [];
  },
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push }),
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: new Proxy({}, { get: (_target, name) => String(name) }),
  useResolvedAppearance: () => "light",
  useThemedStyles: (createStyles: () => unknown) => createStyles(),
}));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { useI18n: () => ({ t }) };
});
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
vi.mock("../components/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/row-accessories", () => ({ Chevron: () => null, Checkmark: () => null }));
vi.mock("../components/native-action-button", () => ({
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
    ActivityIndicator: () => null,
    Alert: { alert: vi.fn() },
    Keyboard: { dismiss: vi.fn() },
    Platform: { OS: "ios" },
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
    }: {
      accessibilityLabel?: string;
      placeholder?: string;
      value: string;
      onChangeText: (value: string) => void;
      secureTextEntry?: boolean;
    }) =>
      createElement("input", {
        "aria-label": accessibilityLabel,
        placeholder,
        value,
        type: secureTextEntry ? "password" : "text",
        onInput: (event: { currentTarget: HTMLInputElement }) =>
          onChangeText(event.currentTarget.value),
      }),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Models)));
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

it("selects the Ollama preset through the compatible form with a visible key field", async () => {
  const providerButton = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Provider"),
  );
  expect(providerButton).toBeDefined();
  await act(async () => providerButton!.click());
  const route = push.mock.calls.at(-1)?.[0] as { params: { requestId: string } };
  const request = modelPickerRequest(route.params.requestId)!;
  const preset = request.choices.find((choice) => choice.label === "Ollama Cloud")!;
  expect(preset).toBeDefined();
  expect(preset.providerLabel).toBe("All providers");
  expect(request.choices.filter((choice) => choice.label === "Ollama Cloud")).toHaveLength(1);
  await act(async () => {
    selectPickerModel(route.params.requestId, preset.key);
  });
  expect(field("OpenAI-compatible server URL")?.value).toBe("https://ollama.com/v1");
  expect(field("API key")?.placeholder).toBe("Ollama API key");
  expect(field("API key")?.type).toBe("password");
  expect(
    [...container.querySelectorAll("button")].filter((button) =>
      ["Setup help", "API key"].includes(button.textContent ?? ""),
    ),
  ).toHaveLength(0);
});

it("shows a saved Ollama connection only once in the connected section", async () => {
  saved.baseUrl = "https://ollama.com/";
  await act(async () => {
    root.unmount();
  });
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(Models));
  });
  const button = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.startsWith("Provider"),
  )!;
  await act(async () => button.click());
  const route = push.mock.calls.at(-1)?.[0] as { params: { requestId: string } };
  const choices = modelPickerRequest(route.params.requestId)!.choices.filter(
    (choice) => choice.label === "Ollama Cloud",
  );
  expect(choices).toHaveLength(1);
  expect(choices[0]?.providerLabel).toBe("Connected");
  saved.baseUrl = savedEndpoint;
});

it("keeps setup help and API key collapsible for generic compatible servers", async () => {
  const row = (name: string) =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === name)!;
  expect(field("API key")).toBeNull();
  expect(container.textContent).not.toContain("Rakazo adds /v1");
  await act(async () => row("Setup help").click());
  expect(container.textContent).toContain("Rakazo adds /v1");
  await act(async () => row("Setup help").click());
  expect(container.textContent).not.toContain("Rakazo adds /v1");
  await act(async () => row("API key").click());
  expect(field("API key")).not.toBeNull();
  await act(async () => row("API key").click());
  expect(field("API key")).toBeNull();
});

it.each(["https://ollama.com", "https://ollama.com/v1/"])(
  "keeps Save enabled with a saved Ollama key at %s",
  async (baseUrl) => {
    saved.baseUrl = "https://ollama.com/v1";
    saved.hasKey = true;
    try {
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () => root.render(createElement(Models)));
      await change("OpenAI-compatible server URL", baseUrl);
      const save = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Save",
      );
      expect(save).toBeDefined();
      expect(save!.disabled).toBe(false);
      await change("OpenAI-compatible server URL", "https://other.test/v1");
      await change("OpenAI-compatible server URL", "https://ollama.com/v1/");
      expect(save!.disabled).toBe(false);
    } finally {
      saved.baseUrl = savedEndpoint;
      saved.hasKey = false;
    }
  },
);
