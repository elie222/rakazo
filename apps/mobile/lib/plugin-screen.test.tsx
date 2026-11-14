// @vitest-environment jsdom
import type { ReactElement, ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PluginRoute from "../app/(settings)/plugin";
import { queryClient } from "./query";

const SOURCE = "https://plugins.example.test/notes";
const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  params: {} as Record<string, string>,
  botId: "",
  focused: true,
  header: undefined as undefined | (() => ReactElement<{ label: string; onPress: () => void }>),
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async () => ({ apiBase: "https://app.example.test", headers: {} }),
  rpc: (proc: string, input: unknown) => state.rpc(proc, input),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("./last-bot", () => ({ loadLastBotId: async () => state.botId }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "red", success: "green" }) }));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./native-controls", () => ({ iosAtLeast: () => false }));
vi.mock("expo-router", () => ({
  Redirect: () => null,
  useRouter: () => ({ navigate: vi.fn() }),
  useLocalSearchParams: () => state.params,
  useNavigation: () => ({
    setOptions: (options: { headerRight?: typeof state.header }) => {
      state.header = options.headerRight;
    },
  }),
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    useEffect(() => {
      if (state.focused) return effect();
    }, [effect, state.focused]);
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/plugin-icon", () => ({ PluginIcon: () => null }));
vi.mock("../components/skill-symbol", () => ({ SkillSymbol: () => null }));
vi.mock("../components/space-availability", () => ({
  reachesOtherSpaces: () => false,
  SpaceAvailabilityPicker: () => null,
  useOwnSpaces: () => [],
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
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Pressable: View,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    ActivityIndicator: () => <span role="status" />,
    StyleSheet: { create: (styles: unknown) => styles },
    Alert: { alert: vi.fn() },
    Linking: { openURL: vi.fn() },
  };
});

const preview = {
  format: "agent-plugins",
  name: "Notes",
  version: null,
  description: "Keeps notes",
  author: null,
  homepage: null,
  repository: null,
  license: null,
  keywords: [],
  resolvedSha: "a".repeat(40),
  digest: `sha256:${"b".repeat(64)}`,
  skills: [],
  mcpServers: [
    {
      name: "notes",
      transport: "streamable_http",
      endpoint: "https://notes.example.test/mcp",
      staticHeaderKeys: [],
    },
  ],
  skipped: [],
};
const install = { id: "install-1", kind: "plugin", name: "Notes", source: SOURCE, config: preview };
const server = {
  id: "server-1",
  installId: "install-1",
  name: "Notes: notes",
  endpoint: "https://notes.example.test/mcp",
  enabled: true,
  health: { status: "ok" },
};

/** What the server answers; a test swaps one answer to make a save or a later read fail. */
let answers: Record<string, () => Promise<unknown>>;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  state.params = { source: SOURCE, installedSource: SOURCE, name: "Notes" };
  state.botId = "";
  state.focused = true;
  state.header = undefined;
  answers = {
    "capabilities/list": async () => [],
    "mcp/servers/list": async () => [],
    "mcp/assignments/list": async () => [],
    "capabilities/pluginPreview": async () => preview,
  };
  state.rpc.mockReset().mockImplementation((proc: string) => answers[proc]?.());
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
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
async function render() {
  await act(async () => root.render(<PluginRoute />));
  await settle();
}
async function refocus() {
  state.focused = false;
  await render();
  state.focused = true;
  await render();
}
const headerLabel = () => state.header?.().props.label;
async function pressHeader() {
  await act(async () => state.header?.().props.onPress());
  await settle();
}
async function press(label: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button?.click());
  await settle();
}

it("keeps an install that succeeded when the reload after it fails", async () => {
  await render();
  expect(headerLabel()).toBe("Connect");
  answers["capabilities/install"] = async () => install;
  answers["capabilities/list"] = () => Promise.reject(new Error());
  await pressHeader();
  expect(state.rpc).toHaveBeenCalledWith(
    "capabilities/install",
    expect.objectContaining({ kind: "plugin", source: SOURCE, pluginParts: ["connector"] }),
  );
  expect(container.textContent).toContain("Could not load plugin");
  expect(container.textContent).not.toContain("Could not install plugin");

  answers["capabilities/list"] = async () => [install];
  answers["mcp/servers/list"] = async () => [server];
  await refocus();
  expect(headerLabel()).toBe("Remove");
  expect(container.textContent).not.toContain("Could not load plugin");
});

it("reports an install that failed", async () => {
  await render();
  answers["capabilities/install"] = () => Promise.reject(new Error());
  await pressHeader();
  expect(container.textContent).toContain("Could not install plugin");
  expect(headerLabel()).toBe("Connect");
});

it("keeps a connector enabled for the bot when the reload after it fails", async () => {
  state.botId = "bot-1";
  answers["capabilities/list"] = async () => [install];
  answers["mcp/servers/list"] = async () => [server];
  await render();
  answers["mcp/assignments/approve"] = async () => ({});
  answers["mcp/servers/list"] = () => Promise.reject(new Error());
  await press("Use in this bot");
  expect(state.rpc).toHaveBeenCalledWith("mcp/assignments/approve", {
    botId: "bot-1",
    serverId: "server-1",
  });
  expect(container.textContent).toContain("Could not load plugin");
  expect(container.textContent).not.toContain("Could not enable tools");

  answers["mcp/servers/list"] = async () => [server];
  answers["mcp/assignments/list"] = async () => [{ serverId: "server-1" }];
  await refocus();
  expect(container.textContent).toContain("In this bot");
  expect(container.textContent).not.toContain("Could not load plugin");
});

it("shows the preview again after a failed read and Retry", async () => {
  answers["capabilities/pluginPreview"] = () => Promise.reject(new Error());
  await render();
  expect(container.textContent).toContain("Could not preview plugin");
  answers["capabilities/pluginPreview"] = async () => preview;
  await press("Retry");
  expect(container.textContent).not.toContain("Could not preview plugin");
  expect(container.textContent).toContain("https://notes.example.test/mcp");
});

it("clears a failed connect when Retry reads the preview again", async () => {
  state.params = { ...state.params, managedConnectorId: "test", managedSlug: "notes" };
  answers["connections/catalog"] = async () => [
    { connectorId: "test", slug: "notes", name: "Notes", logo: null, connected: false },
  ];
  answers["connections/list"] = async () => [];
  answers["capabilities/pluginPreview"] = () => Promise.reject(new Error());
  answers["connections/begin"] = () => Promise.reject(new Error());
  await render();
  await pressHeader();
  expect(container.textContent).toContain("Could not connect");
  answers["capabilities/pluginPreview"] = async () => preview;
  await press("Retry");
  expect(container.textContent).not.toContain("Could not connect");
});
