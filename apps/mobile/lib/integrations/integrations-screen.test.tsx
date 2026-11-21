// @vitest-environment jsdom
import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Integrations from "../../app/(settings)/integrations";
import { ConnectorIcon } from "../../components/integrations/connector-icon";
import { queryClient } from "../query/query";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  marketplace: vi.fn(),
  push: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  current: true,
  scope: vi.fn(),
  persisted: vi.fn(),
  focused: true,
  authSession: vi.fn(),
  headerMenu: false,
  navigation: { setOptions: vi.fn() },
}));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
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
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async (spaceId: string | null = "space-fixture") => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
  rpc: (proc: string, ...args: unknown[]) =>
    proc === "marketplace/catalog" ? state.marketplace() : state.rpc(proc, ...args),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: state.authSession }));
vi.mock("../../components/integrations/plugin-icon", () => ({
  PluginIcon: ({ name }: { name: string }) => <span>{name[0]}</span>,
}));
vi.mock("./integrations-cache", () => ({
  integrationsCacheScope: state.scope,
  persistedIntegrationsCacheScope: state.persisted,
  isIntegrationsScopeCurrent: () => state.current,
  readIntegrationsCache: state.read,
  writeIntegrationsCache: state.write,
}));
vi.mock("../inbox/last-bot", () => ({ loadLastBotId: async () => "" }));
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
  state.current = true;
  state.focused = true;
  state.authSession.mockReset().mockResolvedValue({ type: "cancel" });
  queryClient.clear();
  state.headerMenu = false;
  state.navigation.setOptions.mockReset();
  state.scope.mockReset().mockResolvedValue({ userId: "user-a", spaceId: "space-a" });
  state.persisted.mockReset().mockResolvedValue(null);
  state.read.mockReset().mockReturnValue(null);
  state.write.mockReset();
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
async function render(node: ReactNode = <Integrations />) {
  await act(async () => root.render(node));
}
async function settle() {
  await act(flush);
}

it("keeps Search visible and shows rows on a cold load until the first success", async () => {
  await render();
  expect(container.querySelector('input[placeholder="Search apps"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="integrations-loading"]')?.children).toHaveLength(8);
  await act(async () => catalog.resolve([item]));
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
  expect(container.textContent).toContain("Example appAdded");
  expect(state.write).toHaveBeenCalledWith(expect.anything(), {
    catalog: [item],
    connections: [account],
  });
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
  const links = [...container.querySelectorAll("button")].filter((button) =>
    button.textContent?.startsWith("Chat from"),
  );
  expect(links.map((link) => link.textContent)).toEqual(["Chat from Example app"]);
  expect(container.textContent).toContain("Tools for your bot.");
  await act(async () => links[0]!.click());
  expect(state.push).toHaveBeenCalledWith("/messaging");
});
it("paints the cached list and Added state before replacing it in the background", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  expect(container.textContent).toContain("Example appAdded");
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
  await act(async () => catalog.resolve([{ ...item, name: "Refreshed app" }]));
  expect(container.textContent).toContain("Refreshed appAdded");
});
it("keeps cached rows after a refresh failure and offers Retry", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  await act(async () => catalog.reject(new Error("Unavailable")));
  expect(container.textContent).toContain("Example appAdded");
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  );
  expect(retry).toBeDefined();
  state.rpc.mockImplementation((proc: string) =>
    Promise.resolve(
      proc === "connections/catalog" ? [item] : proc === "connections/list" ? [account] : [],
    ),
  );
  await act(async () => retry?.click());
  expect(container.textContent).not.toContain("Retry");
});
it("offers Retry on a cold failure without leaving a loading placeholder", async () => {
  await render();
  await act(async () => catalog.reject(new Error("Unavailable")));
  expect(container.textContent).toContain("Retry");
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
});
it("ignores a refresh after its scope changes", async () => {
  await render();
  state.current = false;
  state.scope.mockRejectedValue(new Error("session changed"));
  await act(async () => catalog.resolve([item]));
  expect(container.textContent).not.toContain("Example app");
  expect(state.write).not.toHaveBeenCalled();
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

it("persists a rename before a pending stale refresh can overwrite it", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  const added = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Added",
  );
  await act(async () => added?.click());
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Renamed",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  state.rpc.mockImplementation((proc: string) =>
    proc === "connections/rename"
      ? Promise.resolve({ ...account, displayName: "Renamed" })
      : Promise.resolve([]),
  );
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(state.write).toHaveBeenLastCalledWith(expect.anything(), {
    catalog: [item],
    connections: [{ ...account, displayName: "Renamed" }],
  });
  await act(async () => catalog.resolve([item]));
  expect(container.querySelector("input")?.value).toBe("Renamed");
  expect(state.write).toHaveBeenCalledTimes(1);
});

it.each(["Remove", "Uninstall"])(
  "persists revoked Added state after %s even if the following refresh fails",
  async (action) => {
    state.read.mockReturnValue({ catalog: [item], connections: [account] });
    await render();
    const added = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Added",
    );
    await act(async () => added?.click());
    state.rpc.mockImplementation((proc: string) =>
      proc === "connections/catalog" ? Promise.reject(new Error()) : Promise.resolve([]),
    );
    const remove = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === action,
    );
    const toolsCalls = state.rpc.mock.calls.filter(([proc]) => proc === "connections/tools").length;
    await act(async () => remove?.click());
    expect(container.textContent).toContain("Could not load integrations");
    expect(container.textContent).not.toContain("Could not revoke connection");
    if (action === "Uninstall") {
      expect(container.querySelector('input[placeholder="Search apps"]')).not.toBeNull();
    } else {
      expect(state.rpc.mock.calls.filter(([proc]) => proc === "connections/tools")).toHaveLength(
        toolsCalls + 1,
      );
    }
    expect(state.write).toHaveBeenLastCalledWith(expect.anything(), {
      catalog: [{ ...item, connected: false }],
      connections: [{ ...account, status: "revoked" }],
    });
  },
);

it("persists a completed connection before refreshing", async () => {
  state.read.mockReturnValue({ catalog: [{ ...item, connected: false }], connections: [] });
  await render();
  state.rpc.mockImplementation((proc: string) => {
    if (proc === "connections/begin")
      return Promise.resolve({ connectionId: account.id, authorizationUrl: null });
    if (proc === "connections/complete") return Promise.resolve(account);
    if (proc === "connections/catalog") return Promise.reject(new Error());
    return Promise.resolve([]);
  });
  const add = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Add",
  );
  await act(async () => add?.click());
  expect(state.write).toHaveBeenLastCalledWith(expect.anything(), {
    catalog: [item],
    connections: [account],
  });
  expect(container.textContent).toContain("Example appAdded");
  expect(container.textContent).toContain("Could not load integrations");
  expect(container.textContent).not.toContain("Could not connect");
});

it.each(["Add another", "Remove", "Uninstall"])(
  "still reports an operation failure for %s without changing the saved account",
  async (action) => {
    state.read.mockReturnValue({ catalog: [item], connections: [account] });
    await render();
    const added = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Added",
    );
    await act(async () => added?.click());
    state.rpc.mockImplementation((proc: string) => {
      if (proc === "connections/begin" || proc === "connections/revoke")
        return Promise.reject(new Error("Operation rejected"));
      if (proc === "connections/catalog") return Promise.reject(new Error());
      return Promise.resolve([]);
    });
    const button = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === action,
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(state.write).not.toHaveBeenCalled();
    expect(container.querySelector('input[placeholder="Search apps"]')).toBeNull();
    expect(container.textContent).not.toContain("Could not load integrations");
    expect(container.textContent).toContain("Operation rejected");
  },
);

it("paints persisted cached rows while identity is pending or offline", async () => {
  state.persisted.mockResolvedValue({ userId: "user-a", spaceId: "space-a" });
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  const rejectIdentity = deferred<never>();
  state.scope.mockReturnValue(rejectIdentity.promise);
  await render();
  expect(container.textContent).toContain("Example appAdded");
  expect(state.rpc).not.toHaveBeenCalled();
  await act(async () => rejectIdentity.reject(new Error("offline")));
  expect(container.textContent).toContain("Example appAdded");
  expect(container.textContent).toContain("Retry");
});

it("rebuilds a stale space and continues refreshing while the screen stays open", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  state.current = false;
  state.scope.mockImplementation(async () => {
    state.current = true;
    return { userId: "user-a", spaceId: "space-b" };
  });
  state.read.mockReturnValue(null);
  state.rpc.mockImplementation((proc: string) =>
    Promise.resolve(
      proc === "connections/catalog" ? [{ ...item, name: "Recovered app", connected: false }] : [],
    ),
  );
  await act(async () => catalog.resolve([item]));
  expect(state.scope).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("Example app");
  expect(container.textContent).toContain("Recovered appAdd");
  expect(state.write).toHaveBeenLastCalledWith(
    { userId: "user-a", spaceId: "space-b" },
    {
      catalog: [{ ...item, name: "Recovered app", connected: false }],
      connections: [],
    },
  );
});

it("keeps sources loading when a rename cancels the catalog refresh", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  const sources = deferred<unknown[]>();
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc: string) =>
    proc === "capabilities/list" ? sources.promise : original(proc),
  );
  await render();
  await act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Added")?.click(),
  );
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Renamed",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  state.rpc.mockImplementation((proc: string) =>
    proc === "connections/rename"
      ? Promise.resolve({ ...account, displayName: "Renamed" })
      : original(proc),
  );
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await act(async () => catalog.resolve([item]));
  await act(async () =>
    sources.resolve([
      { id: "source-a", name: "Installed source", kind: "mcp", source: "https://example.test/mcp" },
    ]),
  );
  await act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Back")?.click(),
  );
  expect(container.querySelector('[data-testid="tool-source"]')?.textContent).toContain(
    "Installed source",
  );
  expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Remove")).toBe(
    true,
  );
});

it("keeps loaded plugins out of a loading state when scope lookup fails on refresh", async () => {
  await render();
  await act(async () => catalog.resolve([item]));
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  state.focused = false;
  await render();
  state.scope.mockRejectedValue(new Error("Scope unavailable"));
  state.focused = true;
  await render();
  expect(container.textContent).toContain("Scope unavailable");
  expect(container.textContent).toContain("Retry");
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  expect(state.marketplace).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
  "waits for new plugins after a scope switch with a cached empty catalog (stale scope: %s)",
  async (staleScope) => {
    const guidance = "Configure a plugin catalog on the server to connect apps.";
    await render();
    await act(async () => catalog.resolve([]));
    expect(container.textContent).toContain(guidance);
    state.focused = false;
    await render();
    state.current = !staleScope;
    state.scope.mockImplementation(async () => {
      state.current = true;
      return { userId: "user-a", spaceId: "space-b" };
    });
    state.read.mockReturnValue({ catalog: [], connections: [] });
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
    expect(container.textContent).toContain(guidance);
  },
);

it("refreshes a different space on focus return and rejects the blurred refresh", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  state.focused = false;
  await render();
  await act(async () => catalog.resolve([{ ...item, name: "Late old app" }]));
  expect(container.textContent).not.toContain("Late old app");
  state.current = false;
  state.scope.mockImplementation(async () => {
    state.current = true;
    return { userId: "user-a", spaceId: "space-b" };
  });
  state.read.mockReturnValue(null);
  const pending = deferred<(typeof item)[]>();
  state.rpc.mockImplementation((proc: string) =>
    proc === "connections/catalog" ? pending.promise : Promise.resolve([]),
  );
  state.focused = true;
  await render();
  expect(container.textContent).not.toContain("Example app");
  expect(container.querySelector('[data-testid="integrations-loading"]')).not.toBeNull();
  await act(async () => pending.resolve([{ ...item, name: "New space app", connected: false }]));
  expect(container.textContent).toContain("New space appAdd");
  expect(state.scope).toHaveBeenCalledTimes(2);
});

it.each(["rename", "revoke", "uninstall", "connect"])(
  "rejects a late %s result after an in-place space recovery",
  async (action) => {
    state.read.mockReturnValue({ catalog: [item], connections: [account] });
    await render();
    await act(async () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Added")?.click(),
    );
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
    if (action === "rename") {
      const input = container.querySelector("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "Old space rename",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    } else {
      const label =
        action === "revoke" ? "Remove" : action === "uninstall" ? "Uninstall" : "Add another";
      await act(async () =>
        [...container.querySelectorAll("button")].find((b) => b.textContent === label)?.click(),
      );
    }
    expect(state.rpc).toHaveBeenCalledWith(
      action === "rename"
        ? "connections/rename"
        : action === "connect"
          ? "connections/complete"
          : "connections/revoke",
      expect.anything(),
    );
    state.current = false;
    state.scope.mockImplementation(async () => {
      state.current = true;
      return { userId: "user-a", spaceId: "space-b" };
    });
    state.read.mockReturnValue(null);
    state.rpc.mockImplementation((proc: string) =>
      Promise.resolve(
        proc === "connections/catalog"
          ? [{ ...item, name: "New space app", connected: false }]
          : [],
      ),
    );
    await act(async () => catalog.resolve([item]));
    expect(container.textContent).toContain("New space appAdd");
    const writes = state.write.mock.calls.length;
    await act(async () => pending.resolve({ ...account, displayName: "Old space rename" }));
    expect(state.write).toHaveBeenCalledTimes(writes);
    expect(state.write).toHaveBeenLastCalledWith(
      { userId: "user-a", spaceId: "space-b" },
      {
        catalog: [{ ...item, name: "New space app", connected: false }],
        connections: [],
      },
    );
    expect(container.textContent).not.toContain("Old space rename");
  },
);

it("ignores an old focus identity error after the new focus succeeds", async () => {
  const pending = deferred<never>();
  state.scope.mockReturnValueOnce(pending.promise);
  await render();
  state.focused = false;
  await render();
  state.scope.mockResolvedValue({ userId: "user-a", spaceId: "space-b" });
  state.rpc.mockImplementation((proc: string) =>
    Promise.resolve(
      proc === "connections/catalog" ? [{ ...item, name: "New space app", connected: false }] : [],
    ),
  );
  state.focused = true;
  await render();
  expect(container.textContent).toContain("New space appAdd");
  await act(async () => pending.reject(new Error("Old focus failed")));
  expect(container.textContent).not.toContain("Old focus failed");
  expect(container.textContent).not.toContain("Retry");
  expect(container.textContent).toContain("New space appAdd");
});

it("shows registered MCP servers with connector initials and sentence case statuses", async () => {
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string) =>
    proc === "mcp/servers/list"
      ? Promise.resolve([
          {
            id: "saved",
            name: "Saved server",
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
        ])
      : fallback?.(proc),
  );
  await render();
  const rows = container.querySelectorAll('[data-testid="registered-mcp-server"]');
  expect([...rows].map((row) => row.textContent)).toEqual([
    "SSaved serverConnected",
    "OOpen serverNot connected",
    "CClient serverNeeds an OAuth client ID",
    "BBroken serverNot working",
    "EExpired serverNeeds sign-inReconnect",
  ]);
  for (const row of [...rows].slice(0, 4)) expect(row.querySelector("button")).toBeNull();
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
  expect(container.textContent).not.toContain("No apps match your search.");
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
    expect(container.querySelector('[data-testid="connected-apps"]')?.textContent).toBe(
      `AppsCCalcom1 connector${action}`,
    );
  },
);

async function openMcpSource() {
  await render();
  await act(async () => catalog.resolve([]));
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
  );
  expect(state.rpc).toHaveBeenCalledWith("mcp/oauth/begin", {
    serverId: "oauth-server",
    client: "mobile",
  });
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
  expect(state.rpc).toHaveBeenCalledWith("mcp/oauth/complete", {
    sessionId: "mobile-session",
    code: "code-1",
    state: "mobile-session",
  });
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
  await press("Gateway");
  expect(
    container.querySelector<HTMLInputElement>('input[placeholder="https://example.com/mcp"]')
      ?.value,
  ).toBe("https://gateway.example.test/mcp");
  await press("Verify and add");

  expect(state.rpc).toHaveBeenCalledWith(
    "mcp/servers/create",
    expect.objectContaining({ name: "Gateway", endpoint: "https://gateway.example.test/mcp" }),
  );
  expect(state.rpc).not.toHaveBeenCalledWith("capabilities/install", expect.anything());
  expect(state.rpc).toHaveBeenCalledWith("mcp/oauth/begin", {
    serverId: "gateway-server",
    client: "mobile",
  });
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
  await press("Reconnect");
  expect(state.rpc).toHaveBeenCalledWith("mcp/oauth/begin", {
    serverId: "expired",
    client: "mobile",
  });
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
  await press("Reconnect");
  await press("MCP server");
  await press("Verify and add");
  await press("Verify and add");
  expect(state.rpc.mock.calls.filter(([proc]) => proc === "capabilities/install")).toHaveLength(1);
});

it("clears a failed MCP sign-in once the servers load again", async () => {
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
  await press("Reconnect");
  expect(container.textContent).toContain("Could not start MCP OAuth");
  await press("MCP server");
  await press("Verify and add");
  expect(container.querySelector('input[placeholder="https://example.com/mcp"]')).toBeNull();
  expect(container.textContent).toContain("Expired server");
  expect(container.textContent).not.toContain("Could not start MCP OAuth");
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
  await searchFor("tracker");
  expect(container.textContent).toContain("No apps match your search.");
  expect(state.rpc).not.toHaveBeenCalledWith("capabilities/catalogSearch", expect.anything());

  await press("Search more apps");
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
  expect(state.rpc).not.toHaveBeenCalledWith("mcp/oauth/complete", expect.anything());
  // A cancelled sign-in still shows the added server, so it can be connected later.
  expect(state.rpc.mock.calls.filter(([proc]) => proc === "mcp/servers/list").length).toBe(2);
});

it("offers Connect on a catalog server whose sign-in failed", async () => {
  mockCatalogConnect();
  state.authSession.mockRejectedValue(new Error("The browser could not open"));
  await render();
  await act(async () => catalog.resolve([]));
  await searchFor("tracker");
  await press("Search more apps");
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
  await searchFor("tracker");
  await press("Search more apps");
  await press("Connect");
  await press("Security & Ops");
  await act(async () => browser.resolve({ type: "cancel" }));
  await settle();
  await press("All");

  expect(container.querySelector('[data-testid="registered-mcp-server"]')?.textContent).toBe(
    "TTrackerNot connectedConnect",
  );
});

it("does not offer a catalog server that needs a key", async () => {
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) =>
    proc === "capabilities/catalogSearch"
      ? Promise.resolve(catalogResult({ type: "bearer" }))
      : fallback?.(proc, args),
  );
  await render();
  await act(async () => catalog.resolve([]));
  await searchFor("tracker");
  await press("Search more apps");

  expect(container.querySelector('[data-testid="integration-catalog-search"]')?.textContent).toBe(
    "No apps match your search.",
  );
  expect(container.textContent?.match(/No apps match your search\./g)).toHaveLength(1);
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
  await searchFor("example");
  await press("Search more apps");

  expect(container.textContent).toContain("Example app");
  expect(container.textContent).not.toContain("No apps match your search.");
});
