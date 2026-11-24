// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { deferred, flush } from "@rakazo/core/test-async";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import McpServerRoute from "../../app/(settings)/mcp-server";
import { rpc } from "../api/api";
import { formRead, queryClient, rpcQuery } from "../query/query";

const back = vi.fn();
const alert = vi.hoisted(() => vi.fn());
const navigation = vi.hoisted(() => ({ options: {} as Record<string, unknown> }));
vi.mock("../api/api", () => ({
  rpc: vi.fn(),
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async (spaceId: string | null = "space-1") => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../native/announce", () => ({ announceToScreenReader: vi.fn() }));
vi.mock("../native/native", () => ({
  native: {},
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("../api/user-error", () => ({
  errorText: (_: unknown, fallback = "Something went wrong. Try again.") => fallback,
}));
vi.mock("../native/native-controls", () => ({ iosAtLeast: () => false }));
vi.mock("../query/screen-query", async () => {
  const { queryClient } = await import("../query/query");
  return {
    useScreenQuery: (read: Parameters<typeof useQuery>[0]) => useQuery(read, queryClient),
  };
});
vi.mock("expo-router", () => ({
  useNavigation: () => ({
    setOptions: (options: Record<string, unknown>) => Object.assign(navigation.options, options),
  }),
  useLocalSearchParams: () => ({ id: "srv-1" }),
  useRouter: () => ({ back }),
}));
vi.mock("../../components/bots/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../../components/native/native-symbol", () => ({ NativeSymbol: () => <i>✓</i> }));
vi.mock("../../components/native/native-action-button", () => ({
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
vi.mock("../../components/native/native-segmented-control", () => ({
  NativeSegmentedControl: ({
    options,
    onChange,
  }: {
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
  }) => (
    <>
      {options.map((option) => (
        <button key={option.value} type="button" onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </>
  ),
}));
vi.mock("../../components/settings/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
  SettingsInputRow: ({
    accessibilityLabel,
    placeholder,
    value,
    onChangeText,
  }: {
    accessibilityLabel?: string;
    placeholder?: string;
    value?: string;
    onChangeText?: (text: string) => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(event) => onChangeText?.(event.target.value)}
    />
  ),
  SettingsSwitch: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={label}
      checked={value}
      onChange={(event) => onChange(event.target.checked)}
    />
  ),
  SettingsRow: ({
    title,
    value,
    trailing,
    disabled,
    onPress,
  }: {
    title: string;
    value?: string;
    trailing?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {value === undefined ? title : `${title}: ${value}`}
      {trailing}
    </button>
  ),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Text: View,
    ActivityIndicator: () => <span role="status" />,
    Alert: { alert },
    StyleSheet: { create: (styles: unknown) => styles },
  };
});

const remote = {
  id: "srv-1",
  spaceId: "space-1",
  slug: "tracker",
  name: "Tracker",
  description: "",
  transport: "streamable_http",
  endpoint: "https://tracker.example.test/mcp",
  command: null,
  hasArgs: false,
  envKeys: [],
  fileKeys: [],
  headerKeys: ["x-api-key"],
  hasSecret: true,
  oauthStatus: "none",
  oauthClientId: null,
  health: { status: "ok", message: null, toolCount: 3, checkedAt: null },
  enabled: true,
  verbatimResults: false,
  revision: 1,
  allBots: true,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

let server: Record<string, unknown> = remote;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The server status text both apps share is translated at run time, so it needs a locale.
  i18n.load("en", {});
  i18n.activate("en");
  queryClient.clear();
  server = remote;
  vi.mocked(rpc).mockImplementation((async (path: string) => {
    if (path === "mcp/servers/list") return [server];
    if (path === "bots/list")
      return [
        { id: "bot-1", name: "Chief", archivedAt: null },
        { id: "bot-2", name: "Scout", archivedAt: null },
        { id: "bot-old", name: "Retired", archivedAt: "2026-10-01T00:00:00.000Z" },
      ];
    if (path === "mcp/assignments/all") return [];
    return server;
  }) as never);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  navigation.options = {};
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(<McpServerRoute />));
  await act(flush);
}
/** Taps the header's Save; false when it is disabled. */
async function save() {
  const headerRight = navigation.options.headerRight as () => ReactNode;
  const header = container.appendChild(document.createElement("header"));
  const headerRoot = createRoot(header);
  await act(async () => headerRoot.render(headerRight()));
  const button = header.querySelector("button") as HTMLButtonElement;
  const enabled = !button.disabled;
  await act(async () => button.click());
  await act(async () => headerRoot.unmount());
  await act(flush);
  return enabled;
}
async function type(label: string, text: string) {
  const input = container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function tap(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  );
  await act(async () => button?.click());
}
const writes = () =>
  vi
    .mocked(rpc)
    .mock.calls.filter(
      ([path]) => !["mcp/servers/list", "bots/list", "mcp/assignments/all"].includes(path),
    )
    .map(([path, body]) => [path, body]);

it("saves a new name and token while keeping the stored header", async () => {
  await render();
  expect(container.textContent).toContain("Status: Connected");
  expect(await save()).toBe(false);

  await type("Name", "Issue tracker");
  await type("Bearer token", "token-placeholder");
  expect(await save()).toBe(true);
  expect(writes()).toEqual([
    [
      "mcp/servers/update",
      {
        id: "srv-1",
        config: {
          slug: "tracker",
          name: "Issue tracker",
          description: "",
          enabled: true,
          verbatimResults: false,
          transport: "streamable_http",
          endpoint: "https://tracker.example.test/mcp",
          headers: { "x-api-key": "" },
          secret: "token-placeholder",
        },
      },
    ],
  ]);
});

it("limits the server to chosen bots without touching its settings", async () => {
  await render();
  await tap("Chosen bots");
  expect(container.textContent).not.toContain("Retired");
  await tap("Scout");
  expect(await save()).toBe(true);
  expect(writes()).toEqual([
    ["mcp/servers/agents", { id: "srv-1", allBots: false, botIds: ["bot-2"] }],
  ]);
});

it("lets a stdio server's bots change but not its launch settings", async () => {
  server = { ...remote, transport: "stdio", endpoint: null, command: "npx", headerKeys: [] };
  await render();
  expect(container.querySelector('input[aria-label="Name"]')).toBeNull();
  expect(container.textContent).toContain("npx");
  await tap("Chosen bots");
  await tap("Chief");
  expect(await save()).toBe(true);
  expect(writes()).toEqual([
    ["mcp/servers/agents", { id: "srv-1", allBots: false, botIds: ["bot-1"] }],
  ]);
});

it("tests the connection", async () => {
  await render();
  await tap("Test connection");
  await act(flush);
  expect(writes()).toEqual([["mcp/servers/test", { id: "srv-1" }]]);
});

const updates = () =>
  writes()
    .filter(([path]) => path === "mcp/servers/update")
    .map(([, body]) => (body as { config: Record<string, unknown> }).config);

it("replaces the stored header when it is renamed with a new value", async () => {
  await render();
  await tap("Advanced: In use");
  await type("Header name", "Authorization");
  expect(await save()).toBe(false);
  await type("Header value", "header-placeholder");
  expect(await save()).toBe(true);
  expect(updates()).toEqual([
    expect.objectContaining({ headers: { Authorization: "header-placeholder" } }),
  ]);
});

it("removes the stored header when its name is cleared", async () => {
  await render();
  await tap("Advanced: In use");
  await type("Header name", "");
  expect(await save()).toBe(true);
  expect(updates()).toEqual([expect.objectContaining({ headers: {} })]);
});

it("puts a header value typed without a name in Authorization, as web does", async () => {
  await render();
  await tap("Advanced: In use");
  await type("Header name", "");
  await type("Header value", "header-placeholder");
  expect(await save()).toBe(true);
  expect(updates()).toEqual([
    expect.objectContaining({ headers: { Authorization: "header-placeholder" } }),
  ]);
});

it("asks for the OAuth client secret only once a client ID is typed", async () => {
  await render();
  await tap("Advanced: In use");
  const secret = () =>
    container.querySelector('input[aria-label="OAuth client secret (optional)"]');
  expect(secret()).toBeNull();
  await type("OAuth client ID (optional)", "client-placeholder");
  await type("OAuth client secret (optional)", "secret-placeholder");
  expect(await save()).toBe(true);
  expect(updates()).toEqual([
    expect.objectContaining({
      oauthClient: { clientId: "client-placeholder", clientSecret: "secret-placeholder" },
    }),
  ]);
});

it("goes back when the server was deleted elsewhere", async () => {
  const read = vi.mocked(rpc).getMockImplementation();
  vi.mocked(rpc).mockImplementation(((path: string, ...rest: unknown[]) =>
    path === "mcp/servers/list"
      ? Promise.resolve([])
      : read?.(path as never, ...(rest as []))) as never);
  await render();
  expect(back).toHaveBeenCalledTimes(1);
});

it("saves the transport, an OAuth client and whole tool results", async () => {
  await render();
  await tap("Advanced: In use");
  await tap("SSE");
  await type("OAuth client ID (optional)", "client-placeholder");
  await type("Scopes (optional)", "openid email");
  await act(async () =>
    (
      container.querySelector('input[aria-label="Keep tool results whole"]') as HTMLInputElement
    ).click(),
  );
  expect(await save()).toBe(true);
  expect(updates()).toEqual([
    expect.objectContaining({
      transport: "sse",
      headers: { "x-api-key": "" },
      verbatimResults: true,
      oauthClient: { clientId: "client-placeholder", scope: "openid email" },
    }),
  ]);
});

it("marks Advanced only when the server uses one of its settings", async () => {
  await render();
  expect(container.textContent).toContain("Advanced: In use");
  await act(async () => root.unmount());
  queryClient.clear();
  server = { ...remote, headerKeys: [] };
  root = createRoot(container);
  await render();
  expect(container.textContent).toContain("Advanced");
  expect(container.textContent).not.toContain("In use");
});

it("does not show the stored OAuth client ID", async () => {
  server = { ...remote, oauthClientId: "stored-client" };
  await render();
  await tap("Advanced: In use");
  expect(container.innerHTML).not.toContain("stored-client");
});

it("saves new settings and bot access in one write", async () => {
  await render();
  await type("Name", "Issue tracker");
  await tap("Chosen bots");
  await tap("Scout");
  expect(await save()).toBe(true);
  expect(writes()).toEqual([
    [
      "mcp/servers/save",
      expect.objectContaining({
        id: "srv-1",
        config: expect.objectContaining({ name: "Issue tracker" }),
        access: { allBots: false, botIds: ["bot-2"] },
      }),
    ],
  ]);
});

it("waits for the server list to be read again before deciding the server is gone", async () => {
  const list = deferred<unknown[]>();
  const read = vi.mocked(rpc).getMockImplementation();
  vi.mocked(rpc).mockImplementation(((path: string, ...rest: unknown[]) =>
    path === "mcp/servers/list" ? list.promise : read?.(path as never, ...(rest as []))) as never);
  // A list read before this server was added.
  queryClient.setQueryData(formRead(rpcQuery("mcp/servers/list")).queryKey, []);
  await render();
  expect(back).not.toHaveBeenCalled();
  await act(async () => list.resolve([server]));
  await act(flush);
  expect(back).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Status: Connected");
});

it("stays open when reading the server list again fails", async () => {
  const list = deferred<unknown[]>();
  const read = vi.mocked(rpc).getMockImplementation();
  vi.mocked(rpc).mockImplementation(((path: string, ...rest: unknown[]) =>
    path === "mcp/servers/list" ? list.promise : read?.(path as never, ...(rest as []))) as never);
  queryClient.setQueryData(formRead(rpcQuery("mcp/servers/list")).queryKey, []);
  await render();
  await act(async () => list.reject(new Error("offline")));
  await act(flush);
  expect(back).not.toHaveBeenCalled();
});

it("waits for edited settings to be saved before testing the connection", async () => {
  await render();
  await type("Server URL", "https://other.example.test/mcp");
  await tap("Test connection");
  await act(flush);
  expect(writes()).toEqual([]);
});
