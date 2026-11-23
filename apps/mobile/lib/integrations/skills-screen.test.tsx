// @vitest-environment jsdom
import type { Deferred } from "@rakazo/core/test-async";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SkillsScreen from "../../app/(settings)/skills";
import { queryClient } from "../query/query";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  t: (text: string, values?: Record<string, unknown>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? "")),
}));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../native/native-controls", () => ({ iosAtLeast: () => false }));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../native/native", () => ({
  native: {},
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../api/api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async () => ({ apiBase: "https://app.example.test", headers: {} }),
  rpc: (method: string) => mocks.rpc(method),
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useNavigation: () => ({ setOptions: vi.fn() }),
  useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect]),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/bots/bot-template-icon", () => ({ BotTemplateIcon: () => null }));
vi.mock("../../components/integrations/plugin-icon", () => ({ PluginIcon: () => null }));
vi.mock("../../components/ui/row-accessories", () => ({ Chevron: () => null }));
vi.mock("../../components/integrations/skill-symbol", () => ({ SkillSymbol: () => null }));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    Pressable: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    ActivityIndicator: () => <span role="status" />,
    TextInput: () => null,
    StyleSheet: { create: (styles: unknown) => styles },
  };
});

const catalog = { entries: [], unavailableRegistries: [] as string[] };
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  mocks.rpc.mockReset().mockImplementation(async (method: string) => {
    if (method === "marketplace/catalog") return catalog;
    if (method === "agentSkills/list")
      return [
        { id: "own", name: "Own skill", source: "user" },
        { id: "bundled", name: "Plugin skill", source: "plugin" },
      ];
    return [];
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function settle() {
  await act(flush);
}
async function render() {
  await act(async () => root.render(<SkillsScreen />));
  await settle();
}
const spinner = () => container.querySelector('[role="status"]');
const retry = () =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");

it("shows your own skills and settles the browse list", async () => {
  await render();
  expect(container.textContent).toContain("Own skill");
  expect(container.textContent).not.toContain("Plugin skill");
  expect(spinner()).toBeNull();
  expect(retry()).toBeUndefined();
});

it("offers Retry when a browse read fails and loads again from it", async () => {
  let fail = true;
  mocks.rpc.mockImplementation(async (method: string) => {
    if (method === "capabilities/list" && fail) throw new Error("offline");
    return method === "marketplace/catalog" ? catalog : [];
  });
  await render();
  expect(container.textContent).toContain("Some plugins could not be loaded.");
  expect(spinner()).toBeNull();

  let finish!: Deferred<unknown[]>;
  fail = false;
  mocks.rpc.mockImplementation((method: string) => {
    if (method !== "capabilities/list")
      return Promise.resolve(method === "marketplace/catalog" ? catalog : []);
    finish = deferred<unknown[]>();
    return finish.promise;
  });
  await act(async () => retry()?.click());
  await settle();
  expect(spinner()).not.toBeNull();
  expect(retry()).toBeUndefined();
  await act(async () => finish.resolve([]));
  await settle();
  expect(spinner()).toBeNull();
  expect(container.textContent).not.toContain("Some plugins could not be loaded.");
});

it("marks the list partial when a plugin registry is unavailable", async () => {
  mocks.rpc.mockImplementation(async (method: string) =>
    method === "marketplace/catalog" ? { ...catalog, unavailableRegistries: ["registry"] } : [],
  );
  await render();
  expect(container.textContent).toContain("Some plugins could not be loaded.");
});
