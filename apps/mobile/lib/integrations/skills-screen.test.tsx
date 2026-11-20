// @vitest-environment jsdom
import type { Deferred } from "@rakazo/core/test-async";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SkillsScreen from "../../app/(settings)/skills";
import { queryClient, rpcQuery } from "../query/query";

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
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  );
  return {
    View,
    ScrollView: View,
    Text: ({
      children,
      accessibilityRole,
    }: {
      children?: ReactNode;
      accessibilityRole?: "alert";
    }) => <p role={accessibilityRole}>{children}</p>,
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
const own = () => container.querySelector('[data-testid="your-skills"]');
const retry = (scope: ParentNode = container) =>
  [...scope.querySelectorAll("button")].find((button) => button.textContent === "Retry");

it("shows your own skills and settles the browse list", async () => {
  await render();
  expect(container.textContent).toContain("Own skill");
  expect(container.textContent).not.toContain("Plugin skill");
  expect(spinner()).toBeNull();
  expect(retry()).toBeUndefined();
});

it("recovers your skills without retrying the healthy Browse reads", async () => {
  mocks.rpc.mockImplementation(async (method: string) => {
    if (method === "agentSkills/list") throw new Error("offline");
    return method === "marketplace/catalog" ? catalog : [];
  });
  await render();
  const section = own()!;
  expect(section.querySelector('[role="alert"]')?.textContent).toBe("Could not load your skills.");
  expect(section.textContent).toContain("New skill");
  expect(container.textContent).not.toContain("Some plugins could not be loaded.");

  const callsBeforeRetry = mocks.rpc.mock.calls.length;
  const recovered = deferred<unknown[]>();
  mocks.rpc.mockImplementation(async (method: string) =>
    method === "agentSkills/list"
      ? recovered.promise
      : method === "marketplace/catalog"
        ? catalog
        : [],
  );
  await act(async () => retry(section)?.click());
  await settle();
  expect(mocks.rpc.mock.calls.slice(callsBeforeRetry)).toEqual([["agentSkills/list"]]);
  expect(section.querySelector('[role="status"]')).not.toBeNull();
  expect(retry(section)).toBeUndefined();

  await act(async () =>
    recovered.resolve([{ id: "own", name: "Recovered skill", source: "user" }]),
  );
  await settle();
  expect(section.textContent).toContain("Recovered skill");
  expect(section.querySelector('[role="alert"], [role="status"]')).toBeNull();
});

it("keeps a successful empty skills list distinct from an error", async () => {
  mocks.rpc.mockImplementation(async (method: string) =>
    method === "marketplace/catalog" ? catalog : [],
  );
  await render();
  expect(own()?.textContent).toContain("New skill");
  expect(own()?.querySelector('[role="alert"]')).toBeNull();
  expect(retry()).toBeUndefined();
});

it("keeps cached skills visible when a background refresh fails", async () => {
  await queryClient.fetchQuery(rpcQuery("agentSkills/list"));
  mocks.rpc.mockImplementation(async (method: string) => {
    if (method === "agentSkills/list") throw new Error("offline");
    return method === "marketplace/catalog" ? catalog : [];
  });
  await render();
  expect(queryClient.getQueryState(rpcQuery("agentSkills/list").queryKey)?.status).toBe("error");
  expect(own()?.textContent).toContain("Own skill");
  expect(own()?.querySelector('[role="alert"]')).toBeNull();
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
  expect(own()?.querySelector('[role="alert"]')).toBeNull();
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
