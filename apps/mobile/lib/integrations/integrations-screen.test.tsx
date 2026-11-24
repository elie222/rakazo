// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, createElement, useEffect, useSyncExternalStore } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Integrations from "../../app/(settings)/integrations";
import { ConnectorIcon } from "../../components/integrations/connector-icon";
import { queryClient, rpcQuery } from "../query/query";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  lastBot: vi.fn(),
  marketplace: vi.fn(),
  push: vi.fn(),
  space: "space-a",
  focused: true,
  authSession: vi.fn(),
  headerMenu: false,
  navigation: { setOptions: vi.fn() },
  headerRight: null as (() => ReactNode) | null,
  headerChanged: null as (() => void) | null,
}));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: state.push, setParams: vi.fn() }),
  useLocalSearchParams: () => ({}),
  useNavigation: () => state.navigation,
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    useEffect(() => {
      if (state.focused) return callback();
    }, [callback, state.focused]);
  },
}));
// The plugin catalog has its own seam so app-catalog tests keep their own rpc fakes.
vi.mock("../api/api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => state.space,
  captureApiRequestContext: async (spaceId?: string) => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": spaceId ?? state.space },
  }),
  rpc: (proc: string, ...args: unknown[]) =>
    proc === "marketplace/catalog" ? state.marketplace() : state.rpc(proc, ...args),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: state.authSession }));
vi.mock("../../components/integrations/plugin-icon", () => ({
  PluginIcon: ({ name }: { name: string }) => <span>{name[0]}</span>,
}));
vi.mock("../inbox/last-bot", () => ({ loadLastBotId: () => state.lastBot() }));
vi.mock("../appearance/appearance", () => ({
  mobileTokens: () => ({ destructive: "red", success: "green", warning: "orange" }),
}));
vi.mock("../native/native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("../native/announce", () => ({ announceToScreenReader: vi.fn() }));
vi.mock("../native/native-controls", () => ({ iosAtLeast: () => state.headerMenu }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    children,
    actions,
    onPressAction,
  }: {
    children: ReactNode;
    actions?: { id: string; title: string }[];
    onPressAction?: (event: { nativeEvent: { event: string } }) => void;
  }) => (
    <div>
      {children}
      {actions?.map(({ id, title }) => (
        <button
          key={id}
          type="button"
          onClick={() => onPressAction?.({ nativeEvent: { event: id } })}
        >
          {title}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../../components/native/native-symbol", () => ({
  NativeSymbol: ({ ios, color }: { ios: string; color: string }) => (
    <span data-symbol={ios} data-color={color} />
  ),
}));
vi.mock("../../components/ui/row-accessories", () => ({ Chevron: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/menu-picker", () => ({
  MenuPicker: ({
    choices,
    onChange,
  }: {
    choices: { key: string; label: string }[];
    onChange: (key: string) => void;
  }) => (
    <div>
      {choices.map(({ key, label }) => (
        <button key={key} type="button" onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
    busy,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
  }) => (
    <button type="button" disabled={disabled || busy} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("react-native-svg", () => ({
  fetchText: async (uri: string) => {
    if (uri.includes("failed.svg")) throw new Error("Artwork unavailable");
    if (uri.includes("empty.svg")) return "";
    return uri.includes("oversized.svg") ? " ".repeat(1_000_000) : `<svg data-uri="${uri}"/>`;
  },
  parse: (xml: string, middleware: (ast: unknown) => unknown) => {
    const uri = /data-uri="([^"]*)"/.exec(xml)?.[1] ?? "";
    if (uri.includes("unrenderable")) throw new SyntaxError("Invalid artwork");
    return middleware({
      props: { uri, style: { strokeWidth: "26.83px !important" } },
      children: [],
    });
  },
  SvgAst: ({
    ast,
    override,
  }: {
    ast: { props: { uri: string; style: { strokeWidth: string } } };
    override: { width: number; height: number };
  }) =>
    createElement("svg", {
      "data-uri": ast.props.uri,
      "data-stroke-width": ast.props.style.strokeWidth,
      width: override.width,
      height: override.height,
    }),
}));
vi.mock("react-native", () => {
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  );
  return {
    ActivityIndicator: ({ accessibilityLabel }: { accessibilityLabel?: string }) => (
      <div role="progressbar" aria-label={accessibilityLabel} />
    ),
    View,
    ScrollView: View,
    Text: ({ children, onPress }: { children: ReactNode; onPress?: () => void }) =>
      onPress ? (
        <button type="button" onClick={onPress}>
          {children}
        </button>
      ) : (
        <span>{children}</span>
      ),
    Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
      <button type="button" onClick={onPress}>
        {children}
      </button>
    ),
    TextInput: ({
      placeholder,
      value,
      onChangeText,
      onEndEditing,
    }: {
      placeholder?: string;
      value?: string;
      onChangeText?: (value: string) => void;
      onEndEditing?: () => void;
    }) => (
      <input
        onBlur={onEndEditing}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChangeText?.(event.target.value)}
      />
    ),
    Image: ({ source, onError }: { source: { uri: string }; onError: () => void }) =>
      createElement("img", { src: source.uri, onError }),
    StyleSheet: { create: (styles: unknown) => styles },
    useWindowDimensions: () => ({ width: 390 }),
    Alert: { alert: vi.fn() },
    Linking: { openURL: vi.fn() },
  };
});

const item = {
  connectorId: "test",
  slug: "example",
  name: "Example app",
  logo: "https://example.test/logo.svg",
  connected: true,
  noAuth: false,
};
const account = {
  id: "account-a",
  connectorId: "test",
  provider: "example",
  displayName: "Example",
  status: "connected",
  capabilities: [],
  createdAt: "2026-01-01",
};
let root: Root;
let container: HTMLDivElement;
let catalog: Deferred<(typeof item)[]>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // The plugin catalog text both apps share is translated at run time, so it needs a locale.
  i18n.load("en", {});
  i18n.activate("en");
  state.space = "space-a";
  state.focused = true;
  state.lastBot.mockReset().mockResolvedValue("");
  state.authSession.mockReset().mockResolvedValue({ type: "cancel" });
  queryClient.clear();
  state.headerMenu = false;
  state.headerRight = null;
  state.navigation.setOptions
    .mockReset()
    .mockImplementation((options: { headerRight?: () => ReactNode }) => {
      if ("headerRight" in options) {
        state.headerRight = options.headerRight ?? null;
        state.headerChanged?.();
      }
    });
  state.push.mockReset();
  state.marketplace
    .mockReset()
    .mockResolvedValue({ entries: [], unavailableRegistries: [], skippedEntries: 0 });
  catalog = deferred<(typeof item)[]>();
  state.rpc
    .mockReset()
    .mockImplementation((proc: string) =>
      proc === "connections/catalog"
        ? catalog.promise
        : Promise.resolve(proc === "connections/list" ? [account] : []),
    );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function subscribeToHeader(onChange: () => void) {
  state.headerChanged = onChange;
  return () => {
    state.headerChanged = null;
  };
}
function IntegrationsWithHeader() {
  const headerRight = useSyncExternalStore(subscribeToHeader, () => state.headerRight);
  return (
    <>
      {headerRight?.()}
      <Integrations />
    </>
  );
}
async function render(node: ReactNode = <IntegrationsWithHeader />) {
  await act(async () => root.render(node));
  await act(flush);
}
async function settle() {
  await act(flush);
}
/** What the screen showed last time it was open in the selected Space. */
function cached(catalog: unknown[], connections: unknown[]) {
  queryClient.setQueryData(rpcQuery("connections/catalog").queryKey, catalog as never);
  queryClient.setQueryData(rpcQuery("connections/list").queryKey, connections as never);
}
const listed = () => queryClient.getQueryData(rpcQuery("connections/list").queryKey);
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);
async function typeLabel(value: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
}

it("keeps Search visible and shows rows on a cold load until the first success", async () => {
  await render();
  expect(container.querySelector('input[placeholder="Search apps"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="integrations-loading"]')?.children).toHaveLength(8);
  await act(async () => catalog.resolve([item]));
  await settle();
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
  expect(container.textContent).toContain("Example appAdded");
});
it("leads from an app that is also a chat app here to messaging", async () => {
  state.rpc.mockImplementation((proc: string) =>
    proc === "connections/catalog" ? catalog.promise : Promise.resolve([]),
  );
  await render();
  await act(async () =>
    catalog.resolve([
      { ...item, connected: false, chatApp: true },
      { ...item, slug: "other", name: "Other app", connected: false },
    ] as (typeof item)[]),
  );
  await settle();
  const links = [...container.querySelectorAll("button")].filter((button) =>
    button.textContent?.startsWith("Chat from"),
  );
  expect(links.map((link) => link.textContent)).toEqual(["Chat from Example app"]);
  expect(container.textContent).toContain("Tools for your bot.");
  await act(async () => links[0]!.click());
  expect(state.push).toHaveBeenCalledWith("/messaging");
});
it("paints the cached list and Added state before replacing it in the background", async () => {
  cached([item], [account]);
  await render();
  expect(container.textContent).toContain("Example appAdded");
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
  await act(async () => catalog.resolve([{ ...item, name: "Refreshed app" }]));
  await settle();
  expect(container.textContent).toContain("Refreshed appAdded");
});
it("keeps cached rows after a refresh failure and offers Retry", async () => {
  cached([item], [account]);
  await render();
  await act(async () => catalog.reject(new Error("Unavailable")));
  await settle();
  expect(container.textContent).toContain("Example appAdded");
  expect(button("Retry")).toBeDefined();
  state.rpc.mockImplementation((proc: string) =>
    Promise.resolve(
      proc === "connections/catalog" ? [item] : proc === "connections/list" ? [account] : [],
    ),
  );
  await act(async () => button("Retry")?.click());
  await settle();
  expect(container.textContent).not.toContain("Retry");
});
it("offers Retry on a cold failure without leaving a loading placeholder", async () => {
  await render();
  await act(async () => catalog.reject(new Error("Unavailable")));
  await settle();
  expect(container.textContent).toContain("Retry");
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
});
it("never shows an answer for a Space that is no longer selected", async () => {
  await render();
  state.space = "space-b";
  state.rpc.mockResolvedValue([]);
  await act(async () => catalog.resolve([item]));
  await settle();
  expect(container.textContent).not.toContain("Example app");
});
it("shows the newly selected Space's apps when the screen is opened again", async () => {
  cached([item], [account]);
  await render();
  state.focused = false;
  await render();
  state.space = "space-b";
  const pending = deferred<(typeof item)[]>();
  state.rpc.mockImplementation((proc: string) =>
    proc === "connections/catalog" ? pending.promise : Promise.resolve([]),
  );
  state.focused = true;
  await render();
  expect(container.textContent).not.toContain("Example app");
  expect(container.querySelector('[data-testid="integrations-loading"]')).not.toBeNull();
  await act(async () => pending.resolve([{ ...item, name: "New space app", connected: false }]));
  await settle();
  expect(container.textContent).toContain("New space appAdd");
});
it.each(["https://example.test/logo.svg?version=1", "https://example.test/logo.SVG#icon"])(
  "renders SVG catalog artwork: %s",
  async (logo) => {
    await render(<ConnectorIcon name="Example" logo={logo} size={32} />);
    expect(container.querySelector("svg")?.getAttribute("data-uri")).toBe(logo);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("24");
    expect(container.querySelector("svg")?.getAttribute("height")).toBe("24");
    await render(<ConnectorIcon name="Example" logo="https://example.test/new.svg" />);
    expect(container.querySelector("svg")).not.toBeNull();
  },
);
it("removes inline CSS priority before passing artwork to the native SVG renderer", async () => {
  await render(<ConnectorIcon name="Example" logo="https://example.test/styled.svg" />);
  expect(container.querySelector("svg")?.getAttribute("data-stroke-width")).toBe("26.83px");
});

it("falls back when fetching catalog artwork fails", async () => {
  await render(<ConnectorIcon name="Example" logo="https://example.test/failed.svg" />);
  expect(container.textContent).toBe("E");
  expect(container.querySelector("svg")).toBeNull();
});

it("falls back before parsing oversized catalog artwork", async () => {
  await render(<ConnectorIcon name="Example" logo="https://example.test/oversized.svg" />);
  expect(container.textContent).toBe("E");
  expect(container.querySelector("svg")).toBeNull();
});

it("falls back when catalog artwork is empty", async () => {
  await render(<ConnectorIcon name="Example" logo="https://example.test/empty.svg" />);
  expect(container.textContent).toBe("E");
  expect(container.querySelector("svg")).toBeNull();
});

it("falls back when SVG artwork throws while rendering", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await render(<ConnectorIcon name="Example" logo="https://example.test/unrenderable.svg" />);
    expect(container.textContent).toBe("E");
    expect(container.querySelector("svg")).toBeNull();
    await render(<ConnectorIcon name="Example" logo="https://example.test/new.svg" />);
    expect(container.querySelector("svg")).not.toBeNull();
  } finally {
    error.mockRestore();
  }
});
it("retries extensionless artwork as SVG before falling back", async () => {
  const logo = "https://logos.example.test/api/gmail";
  await render(<ConnectorIcon name="Example" logo={logo} />);
  expect(container.querySelector("img")?.getAttribute("src")).toContain(logo);
  await act(async () => container.querySelector("img")?.dispatchEvent(new Event("error")));
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")?.getAttribute("data-uri")).toBe(logo);
  await render(<ConnectorIcon name="Example" logo="https://example.test/unrenderable.svg" />);
  expect(container.textContent).toBe("E");
});
it("falls back for absent logos and empty names", async () => {
  await render(<ConnectorIcon name=" example" logo={null} />);
  expect(container.textContent).toBe("E");
  await render(<ConnectorIcon name=" " />);
  expect(container.textContent).toBe("?");
});

it("keeps a rename when a refresh sent before it answers", async () => {
  cached([item], [account]);
  await render();
  await act(async () => button("Added")?.click());
  const renamed = { ...account, displayName: "Renamed" };
  const lists = () => state.rpc.mock.calls.filter(([proc]) => proc === "connections/list").length;
  const before = lists();
  state.rpc.mockImplementation((proc: string) =>
    Promise.resolve(
      proc === "connections/rename"
        ? renamed
        : proc === "connections/catalog"
          ? [item]
          : proc === "connections/list"
            ? [renamed]
            : [],
    ),
  );
  await typeLabel("Renamed");
  await settle();
  expect(listed()).toEqual([renamed]);
  // The rename reads the accounts again, as revoking does.
  expect(lists()).toBeGreaterThan(before);
  await act(async () => catalog.resolve([item]));
  await settle();
  expect(container.querySelector("input")?.value).toBe("Renamed");
  expect(listed()).toEqual([renamed]);
});

it("stops a connection waiting on the browser, and any app tapped after it, on leaving", async () => {
  const other = { ...item, slug: "other", name: "Other app", connected: false };
  cached([{ ...item, connected: false }, other], []);
  await render();
  state.rpc.mockImplementation((proc: string) => {
    if (proc === "connections/begin")
      return Promise.resolve({ connectionId: account.id, authorizationUrl: null });
    if (proc === "connections/complete") return Promise.resolve({ ...account, status: "pending" });
    return Promise.resolve([]);
  });
  const begins = () => state.rpc.mock.calls.filter(([proc]) => proc === "connections/begin");
  const adds = () =>
    [...container.querySelectorAll("button")].filter((b) => b.textContent === "Add");
  await act(async () => adds()[0]?.click());
  expect(container.textContent).toContain("Working…");
  await act(async () => {
    adds()[0]?.click();
    state.focused = false;
    root.render(<IntegrationsWithHeader />);
  });
  await settle();
  expect(begins()).toHaveLength(1);
  state.focused = true;
  await render();
  expect(container.textContent).not.toContain("Working…");
  expect(begins()).toHaveLength(1);
});

it("stops polling a connection once another Space is selected", async () => {
  cached([{ ...item, connected: false }], []);
  await render();
  const complete = deferred<unknown>();
  state.rpc.mockImplementation((proc: string) => {
    if (proc === "connections/begin")
      return Promise.resolve({ connectionId: account.id, authorizationUrl: null });
    if (proc === "connections/complete") return complete.promise;
    if (proc === "connections/catalog") return Promise.resolve([{ ...item, connected: false }]);
    return Promise.resolve([]);
  });
  await act(async () => button("Add")?.click());
  await settle();
  expect(container.textContent).toContain("Working…");
  state.space = "space-b";
  await render();
  await act(async () => complete.resolve({ ...account, status: "pending" }));
  await settle();
  state.space = "space-a";
  await render();
  expect(container.textContent).not.toContain("Working…");
  expect(state.rpc.mock.calls.filter(([proc]) => proc === "connections/complete")).toHaveLength(1);
});

it("shows tool permissions loading until the app returns an empty catalog", async () => {
  cached([item], [account]);
  const tools = deferred<unknown>();
  state.rpc.mockImplementation((proc: string) => {
    if (proc === "connections/tools") return tools.promise;
    if (proc === "connections/catalog") return Promise.resolve([item]);
    if (proc === "connections/list") return Promise.resolve([account]);
    return Promise.resolve([]);
  });
  await render();
  await act(async () => button("Added")?.click());
  const loading = '[role="progressbar"][aria-label="Loading tool permissions…"]';
  expect(container.querySelector(loading)).not.toBeNull();
  await act(async () => tools.resolve([]));
  await settle();
  expect(container.querySelector(loading)).toBeNull();
  expect(container.textContent).not.toContain("Tool permissions");
});

it("shows when the connected app's tool permissions cannot load", async () => {
  cached([item], [account]);
  state.rpc.mockImplementation((proc: string) => {
    if (proc === "connections/tools") return Promise.reject(new Error("Internal server error"));
    if (proc === "connections/catalog") return Promise.resolve([item]);
    if (proc === "connections/list") return Promise.resolve([account]);
    return Promise.resolve([]);
  });
  await render();
  await act(async () => button("Added")?.click());
  await settle();

  expect(container.textContent).toContain("Could not load permissions");
});

it.each(["Remove", "Uninstall"])(
  "keeps the revoked Added state after %s even if the following refresh fails",
  async (action) => {
    cached([item], [account]);
    await render();
    await act(async () => button("Added")?.click());
    await settle();
    state.rpc.mockImplementation((proc: string) =>
      proc === "connections/catalog" ? Promise.reject(new Error()) : Promise.resolve([]),
    );
    const toolsCalls = state.rpc.mock.calls.filter(([proc]) => proc === "connections/tools").length;
    await act(async () => button(action)?.click());
    await settle();
    expect(container.textContent).toContain("Could not load integrations");
    expect(container.textContent).not.toContain("Could not revoke connection");
    if (action === "Uninstall") {
      expect(container.querySelector('input[placeholder="Search apps"]')).not.toBeNull();
    } else {
      expect(state.rpc.mock.calls.filter(([proc]) => proc === "connections/tools")).toHaveLength(
        toolsCalls + 1,
      );
    }
    expect(queryClient.getQueryData(rpcQuery("connections/catalog").queryKey)).toEqual([
      { ...item, connected: false },
    ]);
  },
);

it("shows a completed connection before refreshing", async () => {
  cached([{ ...item, connected: false }], []);
  await render();
  state.rpc.mockImplementation((proc: string) => {
    if (proc === "connections/begin")
      return Promise.resolve({ connectionId: account.id, authorizationUrl: null });
    if (proc === "connections/complete") return Promise.resolve(account);
    if (proc === "connections/catalog") return Promise.reject(new Error());
    return Promise.resolve([]);
  });
  await act(async () => button("Add")?.click());
  await settle();
  expect(queryClient.getQueryData(rpcQuery("connections/catalog").queryKey)).toEqual([item]);
  expect(container.textContent).toContain("Example appAdded");
  expect(container.textContent).toContain("Could not load integrations");
  expect(container.textContent).not.toContain("Could not connect");
});

it.each(["Add another", "Remove", "Uninstall"])(
  "still reports an operation failure for %s",
  async (action) => {
    cached([item], [account]);
    await render();
    await act(async () => button("Added")?.click());
    state.rpc.mockImplementation((proc: string) => {
      if (proc === "connections/begin" || proc === "connections/revoke")
        return Promise.reject(new Error("Operation rejected"));
      if (proc === "connections/catalog") return Promise.reject(new Error());
      return Promise.resolve([]);
    });
    expect(button(action)).toBeDefined();
    await act(async () => button(action)?.click());
    await settle();
    expect(container.querySelector('input[placeholder="Search apps"]')).toBeNull();
    expect(container.textContent).not.toContain("Could not load integrations");
    expect(container.textContent).toContain("Operation rejected");
  },
);

it("keeps sources loading when a rename cancels the catalog refresh", async () => {
  cached([item], [account]);
  const sources = deferred<unknown[]>();
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc: string) =>
    proc === "capabilities/list" ? sources.promise : original(proc),
  );
  await render();
  await act(async () => button("Added")?.click());
  state.rpc.mockImplementation((proc: string) =>
    proc === "connections/rename"
      ? Promise.resolve({ ...account, displayName: "Renamed" })
      : original(proc),
  );
  await typeLabel("Renamed");
  await act(async () => catalog.resolve([item]));
  await settle();
  await act(async () =>
    sources.resolve([
      { id: "source-a", name: "Installed source", kind: "mcp", source: "https://example.test/mcp" },
    ]),
  );
  await act(async () => button("Back")?.click());
  expect(container.querySelector('[data-testid="tool-source"]')?.textContent).toContain(
    "Installed source",
  );
  expect(button("Remove")).toBeDefined();
});

it("keeps loaded plugins showing while the screen reads them again", async () => {
  await render();
  await act(async () => catalog.resolve([item]));
  await settle();
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  state.focused = false;
  await render();
  state.marketplace.mockReturnValue(new Promise(() => undefined));
  state.focused = true;
  await render();
  expect(state.marketplace).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
});

it("waits for the new Space's plugins after a switch with a cached empty catalog", async () => {
  const guidance = "Managed apps haven’t been enabled on this server.";
  await render();
  await act(async () => catalog.resolve([]));
  await settle();
  expect(container.textContent).toContain(guidance);
  state.focused = false;
  await render();
  state.space = "space-b";
  cached([], []);
  const finishPlugins = deferred<unknown>();
  state.marketplace.mockReturnValue(finishPlugins.promise);
  state.rpc.mockResolvedValue([]);
  state.focused = true;
  await render();
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
  expect(container.textContent).not.toContain(guidance);
  await act(async () =>
    finishPlugins.resolve({ entries: [], unavailableRegistries: [], skippedEntries: 0 }),
  );
  await settle();
  expect(container.textContent).toContain(guidance);
});

it.each(["rename", "revoke", "uninstall", "connect"])(
  "never shows a late %s result in the Space selected since",
  async (action) => {
    cached([item], [account]);
    await render();
    await act(async () => button("Added")?.click());
    const pending = deferred<unknown>();
    const original = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((proc: string) => {
      if (
        proc === "connections/rename" ||
        proc === "connections/revoke" ||
        proc === "connections/complete"
      )
        return pending.promise;
      if (proc === "connections/begin")
        return Promise.resolve({ connectionId: account.id, authorizationUrl: null });
      return original(proc);
    });
    if (action === "rename") await typeLabel("Old space rename");
    else {
      const label =
        action === "revoke" ? "Remove" : action === "uninstall" ? "Uninstall" : "Add another";
      await act(async () => button(label)?.click());
    }
    await settle();
    expect(state.rpc).toHaveBeenCalledWith(
      action === "rename"
        ? "connections/rename"
        : action === "connect"
          ? "connections/complete"
          : "connections/revoke",
      expect.anything(),
      expect.anything(),
    );
    state.focused = false;
    await render();
    state.space = "space-b";
    state.rpc.mockImplementation((proc: string) =>
      Promise.resolve(
        proc === "connections/catalog"
          ? [{ ...item, name: "New space app", connected: false }]
          : [],
      ),
    );
    state.focused = true;
    await render();
    await settle();
    expect(container.textContent).toContain("New space appAdd");
    await act(async () =>
      pending.resolve({ ...account, displayName: "Old space rename", status: "connected" }),
    );
    await settle();
    expect(listed()).toEqual([]);
    expect(container.textContent).not.toContain("Old space rename");
    expect(container.textContent).toContain("New space appAdd");
  },
);

it("shows registered MCP servers with connector initials and sentence case statuses", async () => {
  const endpoint = "https://mcp.saved.example.test/mcp";
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string) => {
    if (proc === "capabilities/sourcePresets")
      return Promise.resolve([
        { id: "saved", name: "Saved server", url: endpoint, signIn: true, featured: true },
      ]);
    if (proc === "mcp/servers/list")
      return Promise.resolve([
        {
          id: "saved",
          name: "Saved server",
          endpoint,
          enabled: true,
          hasSecret: true,
          health: { status: "ok" },
        },
        { id: "open", name: "Open server", enabled: true, hasSecret: false, health: {} },
        {
          id: "client",
          name: "Client server",
          enabled: true,
          hasSecret: false,
          oauthClientId: null,
          // Signing in again can't help until a client ID is entered.
          oauthStatus: "reconnect",
          health: { status: "error", code: MCP_OAUTH_CLIENT_REQUIRED },
        },
        { id: "broken", name: "Broken server", enabled: true, health: { status: "error" } },
        {
          id: "expired",
          name: "Expired server",
          enabled: true,
          oauthStatus: "reconnect",
          health: { status: "ok" },
        },
      ]);
    return fallback?.(proc);
  });
  await render();
  const rows = container.querySelectorAll('[data-testid="registered-mcp-server"]');
  expect([...rows].map((row) => row.textContent)).toEqual([
    "SSaved serverConnected",
    "OOpen serverNot connected",
    "CClient serverNeeds an OAuth client ID",
    "BBroken serverNot working",
    "EExpired serverNeeds sign-inReconnect",
  ]);
  // The row itself opens the server; only a server waiting on sign-in adds Connect beside it.
  for (const row of [...rows].slice(0, 4)) expect(row.querySelectorAll("button")).toHaveLength(1);
  expect(rows[0]?.querySelector('[data-symbol="checkmark"]')?.getAttribute("data-color")).toBe(
    "green",
  );
  expect(rows[1]?.querySelector("[data-symbol]")).toBeNull();
  expect(
    rows[2]?.querySelector('[data-symbol="exclamationmark.triangle"]')?.getAttribute("data-color"),
  ).toBe("orange");
  expect(
    rows[3]?.querySelector('[data-symbol="exclamationmark.circle"]')?.getAttribute("data-color"),
  ).toBe("red");
  expect(
    rows[4]?.querySelector('[data-symbol="exclamationmark.triangle"]')?.getAttribute("data-color"),
  ).toBe("orange");

  const search = container.querySelector('input[placeholder="Search apps"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      search,
      "saved",
    );
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const matches = container.querySelectorAll('[data-testid="registered-mcp-server"]');
  expect([...matches].map((row) => row.textContent)).toEqual(["SSaved serverConnected"]);
  expect(container.textContent?.match(/Saved server/g)).toHaveLength(1);
  expect(container.textContent).not.toContain("No apps match your search.");

  await act(async () => matches[0]?.querySelector("button")?.click());
  expect(state.push).toHaveBeenCalledWith({ pathname: "/mcp-server", params: { id: "saved" } });
});

const plugin = {
  id: "cursor:calcom",
  name: "calcom",
  displayName: "Calcom",
  description: "Scheduling",
  keywords: ["cal.com"],
  category: "productivity",
  logo: null,
  homepage: "https://cal.com",
  domains: ["cal.com"],
  registry: "Cursor",
  source: "https://github.com/acme/plugins#calcom",
  installedSource: "https://github.com/acme/plugins#calcom",
  hasConnector: true,
  skillCount: 1,
};

it("lists plugins by category, hides ones named like a managed app, and opens one", async () => {
  state.marketplace.mockResolvedValue({
    entries: [
      plugin,
      { ...plugin, id: "dup", displayName: "Example app", installedSource: "dup" },
      { ...plugin, id: "sentry", displayName: "Sentry", category: "ops" },
    ],
    unavailableRegistries: [],
    skippedEntries: 0,
  });
  await render();
  await act(async () => catalog.resolve([item]));
  await settle();
  const sections = container.querySelectorAll('[data-testid="plugin-section"]');
  expect([...sections].map((section) => section.textContent)).toEqual([
    "ProductivityCCalcomScheduling",
    "Security & OpsSSentryScheduling",
  ]);
  const calcom = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Calcom"),
  );
  await act(async () => calcom?.click());
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/plugin",
    params: {
      source: plugin.source,
      installedSource: plugin.installedSource,
      name: "Calcom",
      description: "Scheduling",
      site: "https://cal.com",
    },
  });
});

it("opens a managed app's brand plugin as one page and keeps skill packs out", async () => {
  state.marketplace.mockResolvedValue({
    entries: [
      { ...plugin, id: "brand", name: "example-app", displayName: "Example app", skillCount: 3 },
      { ...plugin, id: "pack", displayName: "Teaching", hasConnector: false, skillCount: 2 },
    ],
    unavailableRegistries: [],
    skippedEntries: 0,
  });
  await render();
  await act(async () => catalog.resolve([{ ...item, connected: false }]));
  await settle();
  expect(container.textContent).not.toContain("Teaching");
  expect(container.querySelectorAll('[data-testid="plugin-section"]')).toHaveLength(0);
  const tile = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.includes("Example app") && button.textContent !== "Add",
  );
  await act(async () => tile?.click());
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/plugin",
    params: expect.objectContaining({
      name: "Example app",
      managedConnectorId: item.connectorId,
      managedSlug: item.slug,
    }),
  });
});

it("lists a plugin connector under Apps, with its servers kept under the plugin", async () => {
  state.marketplace.mockResolvedValue({
    entries: [plugin],
    unavailableRegistries: [],
    skippedEntries: 0,
  });
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string) =>
    proc === "capabilities/list"
      ? Promise.resolve([
          {
            id: "install-a",
            kind: "plugin",
            name: "calcom",
            source: plugin.installedSource,
            config: {
              format: "grok",
              name: "calcom",
              version: null,
              description: "",
              author: null,
              homepage: null,
              repository: null,
              license: null,
              keywords: [],
              resolvedSha: "a".repeat(40),
              digest: `sha256:${"b".repeat(64)}`,
              skills: [
                { name: "book", description: "" },
                { name: "cancel", description: "" },
              ],
              mcpServers: [],
              skipped: [],
            },
          },
        ])
      : proc === "mcp/servers/list"
        ? Promise.resolve([
            {
              id: "owned",
              installId: "install-a",
              name: "calcom: calcom",
              enabled: true,
              hasSecret: false,
              oauthStatus: "none",
              health: { status: "unknown" },
            },
          ])
        : fallback?.(proc),
  );
  await render();
  await act(async () => catalog.resolve([item]));
  await settle();
  // An install from before parts could be chosen has both; its skills are listed in Skills.
  expect(container.querySelector('[data-testid="connected-apps"]')?.textContent).toBe(
    "AppsCCalcom1 connectorSign in",
  );
  expect(container.querySelector('[data-testid="connected-skills"]')).toBeNull();
  expect(container.querySelectorAll('[data-testid="registered-mcp-server"]')).toHaveLength(0);
});

it.each([
  ["signed in", { oauthStatus: "connected", health: { status: "ok" } }, ""],
  ["signed in with a failed check", { oauthStatus: "connected", health: { status: "error" } }, ""],
  [
    "never signed in with a failed check",
    { oauthStatus: "none", health: { status: "error" } },
    "Sign in",
  ],
  ["disabled", { oauthStatus: "connected", enabled: false }, ""],
  [
    "signed out after an ok check",
    { oauthStatus: "reconnect", health: { status: "ok" } },
    "Sign in",
  ],
])(
  "offers Sign in on a plugin whose connector is %s only when it needs one",
  async (_, change, action) => {
    state.marketplace.mockResolvedValue({
      entries: [plugin],
      unavailableRegistries: [],
      skippedEntries: 0,
    });
    const fallback = state.rpc.getMockImplementation();
    state.rpc.mockImplementation((proc: string) =>
      proc === "capabilities/list"
        ? Promise.resolve([
            {
              id: "install-a",
              kind: "plugin",
              name: "calcom",
              source: plugin.installedSource,
              config: {
                format: "grok",
                name: "calcom",
                version: null,
                description: "",
                author: null,
                homepage: null,
                repository: null,
                license: null,
                keywords: [],
                resolvedSha: "a".repeat(40),
                digest: `sha256:${"b".repeat(64)}`,
                skills: [
                  { name: "book", description: "" },
                  { name: "cancel", description: "" },
                ],
                mcpServers: [],
                skipped: [],
              },
            },
          ])
        : proc === "mcp/servers/list"
          ? Promise.resolve([
              {
                id: "owned",
                installId: "install-a",
                name: "calcom: calcom",
                enabled: true,
                hasSecret: false,
                health: { status: "unknown" },
                ...change,
              },
            ])
          : fallback?.(proc),
    );
    await render();
    await act(async () => catalog.resolve([item]));
    await settle();
    expect(container.querySelector('[data-testid="connected-apps"]')?.textContent).toBe(
      `AppsCCalcom1 connector${action}`,
    );
  },
);

async function openMcpSource() {
  await render();
  await act(async () => catalog.resolve([]));
  await settle();
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "MCP server")
      ?.click();
  });
  expect(container.querySelector('input[placeholder="https://example.com/mcp"]')).not.toBeNull();
}

it("saves native MCP API key auth as a named encrypted header", async () => {
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) =>
    proc === "capabilities/install"
      ? Promise.resolve({ id: "source-key", kind: "mcp", name: "Custom connector" })
      : fallback?.(proc, args),
  );
  await openMcpSource();
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "API key")
      ?.click();
  });
  const credential = container.querySelector('input[placeholder="API key"]');
  expect(credential).not.toBeNull();
  await act(async () => {
    if (!(credential instanceof HTMLInputElement)) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    nativeSetter?.call(credential, "demo-secret-not-real");
    credential.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Verify and add")
      ?.click();
  });
  expect(state.rpc).toHaveBeenCalledWith(
    "capabilities/install",
    expect.objectContaining({
      kind: "mcp",
      credential: "demo-secret-not-real",
      config: { preset: "custom", auth: { type: "header", name: "x-api-key" } },
    }),
    expect.anything(),
  );
});

it("registers an OAuth MCP server and starts the existing browser callback flow", async () => {
  const fallback = state.rpc.getMockImplementation();
  let signedIn = false;
  state.rpc.mockImplementation((proc: string, args: unknown) => {
    if (proc === "mcp/servers/create")
      return Promise.resolve({ id: "oauth-server", name: "Test", enabled: true });
    if (proc === "mcp/servers/list")
      return Promise.resolve([
        {
          id: "oauth-server",
          name: "Test",
          enabled: true,
          oauthStatus: signedIn ? "connected" : "none",
          health: { status: signedIn ? "ok" : "unknown" },
        },
      ]);
    if (proc === "mcp/oauth/begin")
      return Promise.resolve({
        status: "authorization_required",
        sessionId: "mobile-session",
        authorizationUrl: "https://identity.example.test/authorize",
      });
    if (proc === "mcp/oauth/complete") {
      signedIn = true;
      return Promise.resolve({ ok: true });
    }
    return fallback?.(proc, args);
  });
  const browser = deferred<{ type: "success"; url: string }>();
  state.authSession.mockReturnValue(browser.promise);
  await openMcpSource();
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "OAuth")
      ?.click();
  });
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Verify and add")
      ?.click();
  });
  expect(state.rpc).toHaveBeenCalledWith(
    "mcp/servers/create",
    expect.objectContaining({
      transport: "streamable_http",
    }),
    expect.anything(),
  );
  expect(state.rpc).toHaveBeenCalledWith(
    "mcp/oauth/begin",
    { serverId: "oauth-server", client: "mobile" },
    expect.anything(),
  );
  expect(state.authSession).toHaveBeenCalledWith(
    "https://identity.example.test/authorize",
    "rakazo://mcp-oauth",
  );

  const row = () => container.querySelector('[data-testid="registered-mcp-server"]');
  expect(row()?.textContent).toBe("TTestNot connectedConnect");

  await act(async () =>
    browser.resolve({
      type: "success",
      url: "rakazo://mcp-oauth?code=code-1&state=mobile-session",
    }),
  );
  await settle();
  expect(state.rpc).toHaveBeenCalledWith(
    "mcp/oauth/complete",
    { sessionId: "mobile-session", code: "code-1", state: "mobile-session" },
    expect.anything(),
  );
  expect(row()?.textContent).toBe("TTestConnected");
});

it("saves a sign-in preset at its default address and signs in through the in-app session", async () => {
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) => {
    if (proc === "capabilities/sourcePresets")
      return Promise.resolve([
        {
          id: "gateway",
          name: "Gateway",
          defaultUrl: "https://gateway.example.test/mcp",
          signIn: true,
        },
      ]);
    if (proc === "mcp/servers/create")
      return Promise.resolve({ id: "gateway-server", name: "Gateway", enabled: true });
    if (proc === "mcp/oauth/begin")
      return Promise.resolve({
        status: "authorization_required",
        sessionId: "gateway-session",
        authorizationUrl: "https://gateway.example.test/authorize",
      });
    return fallback?.(proc, args);
  });
  await render();
  await act(async () => catalog.resolve([]));
  await settle();
  await press("Gateway");
  expect(
    container.querySelector<HTMLInputElement>('input[placeholder="https://example.com/mcp"]')
      ?.value,
  ).toBe("https://gateway.example.test/mcp");
  await press("Verify and add");

  expect(state.rpc).toHaveBeenCalledWith(
    "mcp/servers/create",
    expect.objectContaining({ name: "Gateway", endpoint: "https://gateway.example.test/mcp" }),
    expect.anything(),
  );
  expect(state.rpc).not.toHaveBeenCalledWith(
    "capabilities/install",
    expect.anything(),
    expect.anything(),
  );
  expect(state.rpc).toHaveBeenCalledWith(
    "mcp/oauth/begin",
    { serverId: "gateway-server", client: "mobile" },
    expect.anything(),
  );
  expect(state.authSession).toHaveBeenCalledWith(
    "https://gateway.example.test/authorize",
    "rakazo://mcp-oauth",
  );
});

const expiredServer = {
  id: "expired",
  name: "Expired server",
  enabled: true,
  oauthStatus: "reconnect",
  health: { status: "ok" },
};
async function press(label: string) {
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === label)
      ?.click();
  });
  await settle();
}

it("keeps an MCP sign-in that needed no browser when the following refresh fails", async () => {
  const fallback = state.rpc.getMockImplementation();
  let begun = false;
  state.rpc.mockImplementation((proc: string, args: unknown) => {
    if (proc === "mcp/servers/list") return Promise.resolve([expiredServer]);
    if (proc === "mcp/oauth/begin") {
      begun = true;
      return Promise.resolve({ status: "already_connected" });
    }
    if (proc === "connections/catalog" && begun) return Promise.reject(new Error());
    return fallback?.(proc, args);
  });
  await render();
  await act(async () => catalog.resolve([]));
  await settle();
  await press("Reconnect");
  expect(state.rpc).toHaveBeenCalledWith(
    "mcp/oauth/begin",
    { serverId: "expired", client: "mobile" },
    expect.anything(),
  );
  expect(container.textContent).toContain("Could not load integrations");
  expect(container.textContent).not.toContain("Could not start MCP OAuth");
});

it("reports an MCP sign-in that could not start", async () => {
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) => {
    if (proc === "mcp/servers/list") return Promise.resolve([expiredServer]);
    if (proc === "mcp/oauth/begin") return Promise.reject(new Error());
    return fallback?.(proc, args);
  });
  await render();
  await act(async () => catalog.resolve([]));
  await settle();
  await press("Reconnect");
  expect(container.textContent).toContain("Could not start MCP OAuth");
});

it("starts the browser sign-in for a new OAuth server when the following refresh fails", async () => {
  const fallback = state.rpc.getMockImplementation();
  let created = false;
  state.rpc.mockImplementation((proc: string, args: unknown) => {
    if (proc === "mcp/servers/create") {
      created = true;
      return Promise.resolve({ id: "oauth-server", name: "Test", enabled: true });
    }
    if (proc === "mcp/oauth/begin")
      return Promise.resolve({
        status: "authorization_required",
        sessionId: "test-session",
        authorizationUrl: "https://identity.example.test/authorize-after-failed-refresh",
      });
    if (proc === "connections/catalog" && created) return Promise.reject(new Error());
    return fallback?.(proc, args);
  });
  await openMcpSource();
  await press("OAuth");
  await press("Verify and add");
  expect(container.querySelector('input[placeholder="https://example.com/mcp"]')).toBeNull();
  expect(container.textContent).toContain("Could not load integrations");
  expect(state.authSession).toHaveBeenCalledWith(
    "https://identity.example.test/authorize-after-failed-refresh",
    "rakazo://mcp-oauth",
  );
});

it("keeps the form open and reports a source that could not be added", async () => {
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) =>
    proc === "capabilities/install" ? Promise.reject(new Error()) : fallback?.(proc, args),
  );
  await openMcpSource();
  await press("Verify and add");
  expect(container.querySelector('input[placeholder="https://example.com/mcp"]')).not.toBeNull();
  expect(container.textContent).toContain("Could not add source");
});

it("does not start an OAuth source's sign-in once the screen is left", async () => {
  const fallback = state.rpc.getMockImplementation();
  const created = deferred<unknown>();
  state.rpc.mockImplementation((proc: string, args: unknown) =>
    proc === "mcp/servers/create" ? created.promise : fallback?.(proc, args),
  );
  await openMcpSource();
  await press("OAuth");
  await press("Verify and add");
  state.focused = false;
  await render();
  await act(async () => created.resolve({ id: "oauth-server", name: "Test", enabled: true }));
  await settle();
  expect(state.rpc).not.toHaveBeenCalledWith(
    "mcp/oauth/begin",
    expect.anything(),
    expect.anything(),
  );
  expect(state.authSession).not.toHaveBeenCalled();
});

it.each(["Space", "form"])(
  "keeps a source draft open when an add finishes after a %s change",
  async (change) => {
    const fallback = state.rpc.getMockImplementation();
    const installed = deferred<unknown>();
    state.rpc.mockImplementation((proc: string, args: unknown) =>
      proc === "capabilities/install" ? installed.promise : fallback?.(proc, args),
    );
    await openMcpSource();
    await press("Verify and add");
    if (change === "Space") {
      state.space = "space-b";
      await render();
    } else {
      // A later form opened while the first add was still on its way.
      await press("Cancel");
      await press("MCP server");
    }
    await act(async () => installed.resolve({ id: "source-a", kind: "mcp", name: "Custom" }));
    await settle();
    expect(container.querySelector('input[placeholder="https://example.com/mcp"]')).not.toBeNull();
  },
);

it("adds a source once when tapped again while a sign-in is still starting", async () => {
  const fallback = state.rpc.getMockImplementation();
  const unanswered = new Promise(() => undefined);
  state.rpc.mockImplementation((proc: string, args: unknown) => {
    if (proc === "mcp/servers/list") return Promise.resolve([expiredServer]);
    if (proc === "mcp/oauth/begin" || proc === "capabilities/install") return unanswered;
    return fallback?.(proc, args);
  });
  await render();
  await act(async () => catalog.resolve([]));
  await settle();
  await press("Reconnect");
  await press("MCP server");
  await press("Verify and add");
  await press("Verify and add");
  expect(state.rpc.mock.calls.filter(([proc]) => proc === "capabilities/install")).toHaveLength(1);
});

it("keeps a failed MCP sign-in through a refresh until Retry", async () => {
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) => {
    if (proc === "mcp/servers/list") return Promise.resolve([expiredServer]);
    if (proc === "mcp/oauth/begin") return Promise.reject(new Error());
    if (proc === "capabilities/install")
      return Promise.resolve({ id: "source-a", kind: "mcp", name: "Custom connector" });
    return fallback?.(proc, args);
  });
  await render();
  await act(async () => catalog.resolve([]));
  await settle();
  await press("Reconnect");
  expect(container.textContent).toContain("Could not start MCP OAuth");
  await press("MCP server");
  await press("Verify and add");
  expect(container.querySelector('input[placeholder="https://example.com/mcp"]')).toBeNull();
  expect(container.textContent).toContain("Expired server");
  // The servers were read again, as on a return from the browser; the failure still explains itself.
  expect(container.textContent).toContain("Could not start MCP OAuth");
  await press("Retry");
  expect(container.textContent).not.toContain("Could not start MCP OAuth");
});

it("starts the next app at once when a waiting connection is replaced, without reading the lists", async () => {
  const other = { ...item, slug: "other", name: "Other app", connected: false };
  cached([{ ...item, connected: false }, other], []);
  await render();
  state.rpc.mockImplementation((proc: string) => {
    if (proc === "connections/begin")
      return Promise.resolve({ connectionId: account.id, authorizationUrl: null });
    if (proc === "connections/complete") return Promise.resolve({ ...account, status: "pending" });
    return new Promise(() => undefined);
  });
  const adds = () =>
    [...container.querySelectorAll("button")].filter((b) => b.textContent === "Add");
  await act(async () => adds()[0]?.click());
  const catalogReads = () =>
    state.rpc.mock.calls.filter(([proc]) => proc === "connections/catalog").length;
  const before = catalogReads();
  await act(async () => adds()[0]?.click());
  await settle();
  // The lists never answer here, so the second app could only start without waiting on them.
  expect(state.rpc.mock.calls.filter(([proc]) => proc === "connections/begin")).toHaveLength(2);
  expect(catalogReads()).toBe(before);
  expect(container.textContent).not.toContain("Could not connect");
});

it("does not tell onboarding about an app once another Space is selected", async () => {
  cached([{ ...item, connected: false }], []);
  await render();
  state.rpc.mockImplementation((proc: string) => {
    if (proc === "connections/begin")
      return Promise.resolve({ connectionId: account.id, authorizationUrl: null });
    if (proc === "connections/complete") return Promise.resolve(account);
    return Promise.resolve([]);
  });
  const lastBotRead = deferred<string>();
  state.lastBot.mockReturnValue(lastBotRead.promise);
  await act(async () => button("Add")?.click());
  await settle();
  state.space = "space-b";
  lastBotRead.resolve("bot-a");
  await settle();
  expect(state.rpc).not.toHaveBeenCalledWith(
    "onboarding/appConnected",
    expect.anything(),
    expect.anything(),
  );
  expect(state.rpc).not.toHaveBeenCalledWith("onboarding/appConnected", expect.anything());
});

it("does not tell onboarding about an app once the screen is left", async () => {
  cached([{ ...item, connected: false }], []);
  await render();
  state.rpc.mockImplementation((proc: string) => {
    if (proc === "connections/begin")
      return Promise.resolve({ connectionId: account.id, authorizationUrl: null });
    if (proc === "connections/complete") return Promise.resolve(account);
    return Promise.resolve([]);
  });
  const lastBotRead = deferred<string>();
  state.lastBot.mockReturnValue(lastBotRead.promise);
  await act(async () => button("Add")?.click());
  await settle();
  state.focused = false;
  await render();
  lastBotRead.resolve("bot-a");
  await settle();
  expect(state.rpc).not.toHaveBeenCalledWith("onboarding/appConnected", expect.anything());
});

it("shows what a partial uninstall revoked without reading the lists again", async () => {
  const second = { ...account, id: "account-b", displayName: "Second" };
  cached([item], [account, second]);
  await render();
  await act(async () => button("Added")?.click());
  state.rpc.mockImplementation((proc: string, input?: { connectionId?: string }) =>
    proc === "connections/revoke" && input?.connectionId === second.id
      ? Promise.reject(new Error("Operation rejected"))
      : Promise.resolve(proc === "connections/revoke" ? { ok: true } : []),
  );
  const reads = () =>
    state.rpc.mock.calls.filter(([proc]) => proc === "connections/catalog").length;
  const before = reads();
  await act(async () => button("Uninstall")?.click());
  await settle();
  expect(container.textContent).toContain("Operation rejected");
  expect(listed()).toEqual([second, { ...account, status: "revoked" }]);
  expect(reads()).toBe(before);
});

it("keeps an app open when its uninstall finishes on a later visit", async () => {
  cached([item], [account]);
  await render();
  await act(async () => button("Added")?.click());
  const revoked = deferred<unknown>();
  state.rpc.mockImplementation((proc: string) =>
    proc === "connections/revoke"
      ? revoked.promise
      : Promise.resolve(proc === "connections/catalog" ? [item] : []),
  );
  await act(async () => button("Uninstall")?.click());
  state.focused = false;
  await render();
  state.focused = true;
  await render();
  await act(async () => revoked.resolve({ ok: true }));
  await settle();
  expect(container.querySelector('input[placeholder="Search apps"]')).toBeNull();
});

it("closes an open app for good when another Space is selected", async () => {
  cached([item], [account]);
  await render();
  await act(async () => button("Added")?.click());
  expect(container.querySelector('input[placeholder="Search apps"]')).toBeNull();
  state.space = "space-b";
  await render();
  state.space = "space-a";
  cached([item], [account]);
  await render();
  expect(container.querySelector('input[placeholder="Search apps"]')).not.toBeNull();
});

it("clears a failed add when another type is picked from the header menu", async () => {
  state.headerMenu = true;
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) =>
    proc === "capabilities/install" ? Promise.reject(new Error()) : fallback?.(proc, args),
  );
  const pick = (label: string) =>
    act(async () =>
      state.navigation.setOptions.mock.lastCall?.[0]
        .unstable_headerRightItems()[0]
        .menu.items.find((entry: { label: string }) => entry.label === label)
        .onPress(),
    );
  await render();
  await act(async () => catalog.resolve([]));
  await settle();
  await pick("MCP server");
  await press("Verify and add");
  expect(container.textContent).toContain("Could not add source");
  await pick("OpenAPI");
  expect(container.textContent).not.toContain("Could not add source");
});

async function searchFor(text: string) {
  const search = container.querySelector('input[placeholder="Search apps"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, text);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const catalogResult = (auth: { type: string } | null) => ({
  enabled: true,
  results: [
    {
      domain: "tracker.example",
      name: "Tracker",
      description: "",
      pageUrl: null,
      surfaces: [
        {
          kind: "mcp",
          slug: "tracker",
          source: "https://mcp.tracker.example/mcp",
          auth: auth && { ...auth, headerName: null, note: null },
        },
      ],
    },
  ],
});

/** The public catalog offers Tracker; connecting adds it, and the server list shows it after. */
function mockCatalogConnect() {
  const fallback = state.rpc.getMockImplementation();
  let added = false;
  state.rpc.mockImplementation((proc: string, args: unknown) => {
    if (proc === "capabilities/catalogSearch")
      return Promise.resolve(catalogResult({ type: "oauth" }));
    if (proc === "mcp/servers/connect") {
      added = true;
      return Promise.resolve({
        server: { id: "tracker-server", name: "Tracker", enabled: true },
        signIn: {
          status: "authorization_required",
          sessionId: "mobile-session",
          authorizationUrl: "https://identity.example.test/authorize",
        },
      });
    }
    if (proc === "mcp/servers/list")
      return Promise.resolve(
        added
          ? [
              {
                id: "tracker-server",
                name: "Tracker",
                enabled: true,
                oauthStatus: "none",
                health: { status: "unknown" },
              },
            ]
          : [],
      );
    return fallback?.(proc, args);
  });
}

it("looks a search up in the public catalog only when asked, and signs in from there", async () => {
  mockCatalogConnect();
  await render();
  await act(async () => catalog.resolve([]));
  await settle();
  await searchFor("tracker");
  expect(container.textContent).toContain("No apps match your search.");
  expect(state.rpc).not.toHaveBeenCalledWith("capabilities/catalogSearch", expect.anything());

  await press("Search public MCP directory");
  expect(state.rpc).toHaveBeenCalledWith(
    "capabilities/catalogSearch",
    { query: "tracker", usePublicCatalog: true },
    expect.anything(),
  );
  const rows = () => container.querySelector('[data-testid="integration-catalog-search"]');
  expect(rows()?.textContent).toBe("TTrackerConnect");
  expect(container.textContent).not.toContain("No apps match your search.");

  await press("Connect");
  expect(state.rpc).toHaveBeenCalledWith(
    "mcp/servers/connect",
    { name: "Tracker", endpoint: "https://mcp.tracker.example/mcp", client: "mobile" },
    expect.anything(),
  );
  expect(state.authSession).toHaveBeenCalledWith(
    "https://identity.example.test/authorize",
    "rakazo://mcp-oauth",
  );
  expect(state.rpc).not.toHaveBeenCalledWith(
    "mcp/oauth/complete",
    expect.anything(),
    expect.anything(),
  );
  // A cancelled sign-in still shows the added server, so it can be connected later.
  expect(state.rpc.mock.calls.filter(([proc]) => proc === "mcp/servers/list").length).toBe(2);
});

it("offers Connect on a catalog server whose sign-in failed", async () => {
  mockCatalogConnect();
  state.authSession.mockRejectedValue(new Error("The browser could not open"));
  await render();
  await act(async () => catalog.resolve([]));
  await settle();
  await searchFor("tracker");
  await press("Search public MCP directory");
  await press("Connect");

  expect(container.querySelector('[data-testid="registered-mcp-server"]')?.textContent).toBe(
    "TTrackerNot connectedConnect",
  );
});

it("shows a catalog server added while another category was open", async () => {
  state.marketplace.mockResolvedValue({
    entries: [plugin, { ...plugin, id: "sentry", displayName: "Sentry", category: "ops" }],
    unavailableRegistries: [],
    skippedEntries: 0,
  });
  mockCatalogConnect();
  const browser = deferred<{ type: "cancel" }>();
  state.authSession.mockReturnValue(browser.promise);
  await render();
  await act(async () => catalog.resolve([]));
  await settle();
  await searchFor("tracker");
  await press("Search public MCP directory");
  await press("Connect");
  await press("Security & Ops");
  await act(async () => browser.resolve({ type: "cancel" }));
  await settle();
  await press("All");

  expect(container.querySelector('[data-testid="registered-mcp-server"]')?.textContent).toBe(
    "TTrackerNot connectedConnect",
  );
});

it("opens the credential form for a catalog server that needs a token", async () => {
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) =>
    proc === "capabilities/catalogSearch"
      ? Promise.resolve(catalogResult({ type: "bearer" }))
      : fallback?.(proc, args),
  );
  await render();
  await act(async () => catalog.resolve([]));
  await settle();
  await searchFor("tracker");
  await press("Search public MCP directory");

  await press("Connect");
  expect(container.querySelector('input[placeholder="Bearer token"]')).not.toBeNull();
  expect(container.querySelector('input[value="https://mcp.tracker.example/mcp"]')).not.toBeNull();
  expect(state.rpc).not.toHaveBeenCalledWith(
    "mcp/servers/connect",
    expect.anything(),
    expect.anything(),
  );
});

it("does not say nothing matched when the screen lists a match but the catalog finds none", async () => {
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) =>
    proc === "capabilities/catalogSearch"
      ? Promise.resolve({ enabled: true, results: [] })
      : fallback?.(proc, args),
  );
  await render();
  await act(async () => catalog.resolve([item]));
  await settle();
  await searchFor("example");
  await press("Search public MCP directory");

  expect(container.textContent).toContain("Example app");
  expect(container.textContent).not.toContain("No apps match your search.");
});
