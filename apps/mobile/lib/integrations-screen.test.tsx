// @vitest-environment jsdom
import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Integrations from "../app/(settings)/integrations";
import { ConnectorIcon } from "../components/connector-icon";
import type * as McpOAuth from "./mcp-oauth";
import { finishMcpSignIn, signInToMcpServer } from "./mcp-oauth";

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
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: state.push, setParams: vi.fn() }),
  useLocalSearchParams: () => ({}),
  useNavigation: () => ({ setOptions: vi.fn() }),
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    useEffect(() => {
      if (state.focused) return callback();
    }, [callback, state.focused]);
  },
}));
// The plugin catalog has its own seam so app-catalog tests keep their own rpc fakes.
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  rpc: (proc: string, ...args: unknown[]) =>
    proc === "marketplace/catalog" ? state.marketplace() : state.rpc(proc, ...args),
}));
vi.mock("../components/plugin-icon", () => ({
  PluginIcon: ({ name }: { name: string }) => <span>{name[0]}</span>,
}));
vi.mock("./integrations-cache", () => ({
  integrationsCacheScope: state.scope,
  persistedIntegrationsCacheScope: state.persisted,
  isIntegrationsScopeCurrent: () => state.current,
  readIntegrationsCache: state.read,
  writeIntegrationsCache: state.write,
}));
vi.mock("./last-bot", () => ({ loadLastBotId: async () => "" }));
vi.mock("./mcp-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof McpOAuth>()),
  signInToMcpServer: vi.fn(async () => "connected"),
  finishMcpSignIn: vi.fn(async () => "connected"),
}));
vi.mock("./appearance", () => ({
  mobileTokens: () => ({ destructive: "red", success: "green", warning: "orange" }),
}));
vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./native-controls", () => ({ iosAtLeast: () => false }));
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
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios, color }: { ios: string; color: string }) => (
    <span data-symbol={ios} data-color={color} />
  ),
}));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
}));
vi.mock("../components/row-accessories", () => ({ Chevron: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/menu-picker", () => ({
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
vi.mock("react-native-svg", () => ({
  SvgUri: ({ uri, onError }: { uri: string; onError: () => void }) => {
    if (uri.includes("unrenderable"))
      throw new SyntaxError('Expected transform functions but "t" found.');
    return createElement("svg", { "data-uri": uri, onClick: onError });
  },
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
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
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
let resolveCatalog: (items: (typeof item)[]) => void;
let rejectCatalog: (error: Error) => void;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.current = true;
  state.focused = true;
  state.scope.mockReset().mockResolvedValue({ userId: "user-a", spaceId: "space-a" });
  state.persisted.mockReset().mockResolvedValue(null);
  state.read.mockReset().mockReturnValue(null);
  state.write.mockReset();
  state.push.mockReset();
  state.marketplace
    .mockReset()
    .mockResolvedValue({ entries: [], unavailableRegistries: [], skippedEntries: 0 });
  const pending = new Promise<(typeof item)[]>((resolve, reject) => {
    resolveCatalog = resolve;
    rejectCatalog = reject;
  });
  state.rpc
    .mockReset()
    .mockImplementation((proc: string) =>
      proc === "connections/catalog"
        ? pending
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

const SIGN_IN = {
  status: "authorization_required",
  sessionId: "session-1",
  authorizationUrl: "https://auth.tracker.example/authorize",
} as const;

it("keeps Search visible and shows rows on a cold load until the first success", async () => {
  await render();
  expect(container.querySelector('input[placeholder="Search apps"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="integrations-loading"]')?.children).toHaveLength(8);
  await act(async () => resolveCatalog([item]));
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
  expect(container.textContent).toContain("Example appAdded");
  expect(state.write).toHaveBeenCalledWith(expect.anything(), {
    catalog: [item],
    connections: [account],
  });
});
it("paints the cached list and Added state before replacing it in the background", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  expect(container.textContent).toContain("Example appAdded");
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
  await act(async () => resolveCatalog([{ ...item, name: "Refreshed app" }]));
  expect(container.textContent).toContain("Refreshed appAdded");
});
it("keeps cached rows after a refresh failure and offers Retry", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  await act(async () => rejectCatalog(new Error("Unavailable")));
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
  await act(async () => rejectCatalog(new Error("Unavailable")));
  expect(container.textContent).toContain("Retry");
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
});
it("ignores a refresh after its scope changes", async () => {
  await render();
  state.current = false;
  state.scope.mockRejectedValue(new Error("session changed"));
  await act(async () => resolveCatalog([item]));
  expect(container.textContent).not.toContain("Example app");
  expect(state.write).not.toHaveBeenCalled();
});
it.each(["https://example.test/logo.svg?version=1", "https://example.test/logo.SVG#icon"])(
  "renders SVG catalog artwork with SvgUri: %s",
  async (logo) => {
    await render(<ConnectorIcon name="Example" logo={logo} size={32} />);
    expect(container.querySelector("svg")?.getAttribute("data-uri")).toBe(logo);
    expect(container.querySelector("img")).toBeNull();
    await act(async () =>
      container.querySelector("svg")?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(container.textContent).toBe("E");
    await render(<ConnectorIcon name="Example" logo="https://example.test/new.svg" />);
    expect(container.querySelector("svg")).not.toBeNull();
  },
);
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
  await act(async () =>
    container.querySelector("svg")?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
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
  await act(async () => resolveCatalog([item]));
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
      proc === "connections/catalog"
        ? Promise.reject(new Error("Unavailable"))
        : Promise.resolve([]),
    );
    const remove = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === action,
    );
    await act(async () => remove?.click());
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
    if (proc === "connections/catalog") return Promise.reject(new Error("Unavailable"));
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
});

it("paints persisted cached rows while identity is pending or offline", async () => {
  state.persisted.mockResolvedValue({ userId: "user-a", spaceId: "space-a" });
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  let rejectIdentity!: (error: Error) => void;
  state.scope.mockReturnValue(
    new Promise((_, reject) => {
      rejectIdentity = reject;
    }),
  );
  await render();
  expect(container.textContent).toContain("Example appAdded");
  expect(state.rpc).not.toHaveBeenCalled();
  await act(async () => rejectIdentity(new Error("offline")));
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
  await act(async () => resolveCatalog([item]));
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
  let resolveSources!: (value: unknown[]) => void;
  const sources = new Promise<unknown[]>((resolve) => {
    resolveSources = resolve;
  });
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc: string) =>
    proc === "capabilities/list" ? sources : original(proc),
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
  await act(async () => resolveCatalog([item]));
  await act(async () =>
    resolveSources([
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
  await act(async () => resolveCatalog([item]));
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
    await act(async () => resolveCatalog([]));
    expect(container.textContent).toContain(guidance);
    state.focused = false;
    await render();
    state.current = !staleScope;
    state.scope.mockImplementation(async () => {
      state.current = true;
      return { userId: "user-a", spaceId: "space-b" };
    });
    state.read.mockReturnValue({ catalog: [], connections: [] });
    let finishPlugins!: (value: unknown) => void;
    state.marketplace.mockReturnValue(
      new Promise((resolve) => {
        finishPlugins = resolve;
      }),
    );
    state.rpc.mockResolvedValue([]);
    state.focused = true;
    await render();
    expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
    expect(container.textContent).not.toContain(guidance);
    await act(async () =>
      finishPlugins({ entries: [], unavailableRegistries: [], skippedEntries: 0 }),
    );
    expect(container.textContent).toContain(guidance);
  },
);

it("refreshes a different space on focus return and rejects the blurred refresh", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  state.focused = false;
  await render();
  await act(async () => resolveCatalog([{ ...item, name: "Late old app" }]));
  expect(container.textContent).not.toContain("Late old app");
  state.current = false;
  state.scope.mockImplementation(async () => {
    state.current = true;
    return { userId: "user-a", spaceId: "space-b" };
  });
  state.read.mockReturnValue(null);
  let resolveNew!: (items: (typeof item)[]) => void;
  const pending = new Promise<(typeof item)[]>((resolve) => {
    resolveNew = resolve;
  });
  state.rpc.mockImplementation((proc: string) =>
    proc === "connections/catalog" ? pending : Promise.resolve([]),
  );
  state.focused = true;
  await render();
  expect(container.textContent).not.toContain("Example app");
  expect(container.querySelector('[data-testid="integrations-loading"]')).not.toBeNull();
  await act(async () => resolveNew([{ ...item, name: "New space app", connected: false }]));
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
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const original = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((proc: string) => {
      if (
        proc === "connections/rename" ||
        proc === "connections/revoke" ||
        proc === "connections/complete"
      )
        return pending;
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
    await act(async () => resolveCatalog([item]));
    expect(container.textContent).toContain("New space appAdd");
    const writes = state.write.mock.calls.length;
    await act(async () => finish({ ...account, displayName: "Old space rename" }));
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
  let failIdentity!: (reason: Error) => void;
  const pending = new Promise((_, reject) => {
    failIdentity = reject;
  });
  state.scope.mockReturnValueOnce(pending);
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
  await act(async () => failIdentity(new Error("Old focus failed")));
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
  await act(async () => resolveCatalog([item]));
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
  await act(async () => resolveCatalog([{ ...item, connected: false }]));
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
  await act(async () => resolveCatalog([item]));
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
    await act(async () => resolveCatalog([item]));
    expect(container.querySelector('[data-testid="connected-apps"]')?.textContent).toBe(
      `AppsCCalcom1 connector${action}`,
    );
  },
);

async function openMcpSource() {
  await render();
  await act(async () => resolveCatalog([]));
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

it("registers an OAuth MCP server, signs in, and reads the servers again", async () => {
  const fallback = state.rpc.getMockImplementation();
  let signedIn = false;
  vi.mocked(signInToMcpServer).mockImplementationOnce(async () => {
    signedIn = true;
    return "connected";
  });
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
    return fallback?.(proc, args);
  });
  await openMcpSource();
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "OAuth")
      ?.click();
  });
  const initialReads = state.rpc.mock.calls.filter(([proc]) => proc === "mcp/servers/list").length;
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
  expect(signInToMcpServer).toHaveBeenCalledWith("oauth-server");
  const row = () => container.querySelector('[data-testid="registered-mcp-server"]');
  expect(
    state.rpc.mock.calls.filter(([proc]) => proc === "mcp/servers/list").length,
  ).toBeGreaterThan(initialReads);
  expect(row()?.textContent).toBe("TTestConnected");
});

it("finds a server in the public catalog and connects it by signing in", async () => {
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) => {
    if (proc === "capabilities/catalogSearch")
      return Promise.resolve({
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
                auth: { type: "oauth", headerName: null, note: null },
              },
              {
                kind: "mcp",
                slug: "tracker-key",
                source: "https://mcp.tracker.example/keyed",
                auth: { type: "header", headerName: "x-api-key", note: null },
              },
            ],
          },
        ],
      });
    if (proc === "mcp/servers/connect")
      return Promise.resolve({
        server: { id: "tracker-server", name: "Tracker", enabled: true },
        signIn: SIGN_IN,
      });
    return fallback?.(proc, args);
  });
  await render();
  await act(async () => resolveCatalog([item]));
  const search = container.querySelector('input[placeholder="Search apps"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      search,
      "tracker",
    );
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === label);

  expect(container.textContent).toContain("No apps match your search.");

  await act(async () => button("Search more apps")?.click());

  expect(state.rpc).toHaveBeenCalledWith("capabilities/catalogSearch", {
    query: "tracker",
    usePublicCatalog: true,
  });
  const results = container.querySelector('[data-testid="integration-catalog-search"]');
  expect(results?.textContent).toBe("TTrackerSign in");
  expect(container.textContent).not.toContain("No apps match your search.");

  await act(async () => button("Sign in")?.click());

  expect(state.rpc).toHaveBeenCalledWith("mcp/servers/connect", {
    name: "Tracker",
    endpoint: "https://mcp.tracker.example/mcp",
    client: "mobile",
  });
  expect(finishMcpSignIn).toHaveBeenCalledWith(SIGN_IN);
});

it("saves a client ID for a server that cannot register Rakazo, then signs in", async () => {
  const server = {
    id: "client",
    slug: "client-server",
    name: "Client server",
    description: "",
    transport: "streamable_http",
    endpoint: "https://mcp.client.example/mcp",
    headerKeys: ["x-team"],
    enabled: true,
    hasSecret: true,
    oauthClientId: null,
    health: { status: "error", code: MCP_OAUTH_CLIENT_REQUIRED },
  };
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) => {
    if (proc === "mcp/servers/list") return Promise.resolve([server]);
    if (proc === "integrationSetup/get")
      return Promise.resolve({ webUrl: "https://rakazo.example.test/integrations/setup" });
    if (proc === "mcp/servers/update") return Promise.resolve(server);
    return fallback?.(proc, args);
  });
  await render();
  const form = container.querySelector('[data-testid="mcp-oauth-client-form"]');
  expect(form?.textContent).toContain("https://rakazo.example.test/mcp/oauth/callback");
  const type = async (placeholder: string, value: string) => {
    const input = form?.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await type("Client ID", " client-1 ");
  await type("Client secret", "secret-1");

  await act(async () =>
    [...(form?.querySelectorAll("button") ?? [])]
      .find((node) => node.textContent === "Sign in")
      ?.click(),
  );

  expect(state.rpc).toHaveBeenCalledWith("mcp/servers/update", {
    id: "client",
    config: {
      slug: "client-server",
      name: "Client server",
      description: "",
      enabled: true,
      transport: "streamable_http",
      endpoint: "https://mcp.client.example/mcp",
      headers: { "x-team": "" },
      oauthClient: { clientId: "client-1", clientSecret: "secret-1" },
    },
  });
  expect(signInToMcpServer).toHaveBeenCalledWith("client");
});

it("drops a catalog answer for a search the user has since changed", async () => {
  let answer: (value: unknown) => void = () => undefined;
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) =>
    proc === "capabilities/catalogSearch"
      ? new Promise((resolve) => {
          answer = resolve;
        })
      : fallback?.(proc, args),
  );
  await render();
  await act(async () => resolveCatalog([item]));
  const search = container.querySelector('input[placeholder="Search apps"]') as HTMLInputElement;
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        search,
        value,
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await type("tracker");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((node) => node.textContent === "Search more apps")
      ?.click(),
  );

  await type("notes");
  await act(async () =>
    answer({
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
              auth: { type: "oauth", headerName: null, note: null },
            },
          ],
        },
      ],
    }),
  );

  const results = container.querySelector('[data-testid="integration-catalog-search"]');
  expect(results?.textContent).toBe("Search more apps");
});

it("shows a catalog server that still needs a client after its sign-in fails", async () => {
  const added = {
    id: "tracker-server",
    slug: "integration-1",
    name: "Tracker",
    description: "",
    transport: "streamable_http",
    endpoint: "https://mcp.tracker.example/mcp",
    headerKeys: [],
    enabled: true,
    hasSecret: false,
    oauthClientId: null,
    health: { status: "error", code: MCP_OAUTH_CLIENT_REQUIRED },
  };
  let servers: unknown[] = [];
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) => {
    if (proc === "mcp/servers/list") return Promise.resolve(servers);
    if (proc === "capabilities/catalogSearch")
      return Promise.resolve({
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
                source: added.endpoint,
                auth: { type: "oauth", headerName: null, note: null },
              },
            ],
          },
        ],
      });
    if (proc === "mcp/servers/connect") {
      servers = [added];
      return Promise.resolve({ server: added, signIn: SIGN_IN });
    }
    if (proc === "integrationSetup/get")
      return Promise.resolve({ webUrl: "https://rakazo.example.test/integrations/setup" });
    return fallback?.(proc, args);
  });
  vi.mocked(finishMcpSignIn).mockRejectedValueOnce(new Error("Needs an OAuth client ID"));
  await render();
  await act(async () => resolveCatalog([item]));
  const search = container.querySelector('input[placeholder="Search apps"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      search,
      "tracker.example",
    );
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === label);
  await act(async () => button("Search more apps")?.click());
  await act(async () => button("Sign in")?.click());

  // The domain search doesn't match the server's name; it shows anyway, with its client form.
  expect(container.querySelector('[data-testid="mcp-oauth-client-form"]')).not.toBeNull();
});

it("says no apps match once when the catalog finds nothing either", async () => {
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) =>
    proc === "capabilities/catalogSearch"
      ? Promise.resolve({ enabled: true, results: [] })
      : fallback?.(proc, args),
  );
  await render();
  await act(async () => resolveCatalog([item]));
  const search = container.querySelector('input[placeholder="Search apps"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      search,
      "nothing-here",
    );
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Search more apps",
  );

  await act(async () => button?.click());

  expect(container.textContent?.split("No apps match your search.")).toHaveLength(2);
});

it("shows a saved client as saved when the sign-in after it fails", async () => {
  const server = {
    id: "client",
    slug: "client-server",
    name: "Client server",
    description: "",
    transport: "streamable_http",
    endpoint: "https://mcp.client.example/mcp",
    headerKeys: [],
    enabled: true,
    hasSecret: false,
    oauthClientId: null as string | null,
    oauthStatus: "none",
    health: { status: "error", code: MCP_OAUTH_CLIENT_REQUIRED },
  };
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) => {
    if (proc === "mcp/servers/list") return Promise.resolve([server]);
    if (proc === "integrationSetup/get")
      return Promise.resolve({ webUrl: "https://rakazo.example.test/integrations/setup" });
    if (proc === "mcp/servers/update") {
      server.oauthClientId = "client-1";
      return Promise.resolve(server);
    }
    return fallback?.(proc, args);
  });
  vi.mocked(signInToMcpServer).mockRejectedValueOnce(new Error("Provider unavailable"));
  await render();
  const form = container.querySelector('[data-testid="mcp-oauth-client-form"]');
  const input = form?.querySelector('input[placeholder="Client ID"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      "client-1",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await act(async () =>
    [...(form?.querySelectorAll("button") ?? [])]
      .find((node) => node.textContent === "Sign in")
      ?.click(),
  );

  expect(container.querySelector('[data-testid="mcp-oauth-client-form"]')).toBeNull();
  expect(container.textContent).not.toContain("Needs an OAuth client ID");
  const row = container.querySelector('[data-testid="registered-mcp-server"]');
  expect(row?.querySelector("button")?.textContent).toBe("Connect");
  expect(container.textContent).toContain("Provider unavailable");
});

it("shows a catalog server added before its sign-in was cancelled", async () => {
  const added = {
    id: "tracker-server",
    slug: "integration-1",
    name: "Tracker",
    description: "",
    transport: "streamable_http",
    endpoint: "https://mcp.tracker.example/mcp",
    headerKeys: [],
    enabled: true,
    hasSecret: false,
    oauthClientId: null,
    health: {},
  };
  let servers: unknown[] = [];
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) => {
    if (proc === "mcp/servers/list") return Promise.resolve(servers);
    if (proc === "capabilities/catalogSearch")
      return Promise.resolve({
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
                source: added.endpoint,
                auth: { type: "oauth", headerName: null, note: null },
              },
            ],
          },
        ],
      });
    if (proc === "mcp/servers/connect") {
      servers = [added];
      return Promise.resolve({ server: added, signIn: SIGN_IN });
    }
    return fallback?.(proc, args);
  });
  vi.mocked(finishMcpSignIn).mockResolvedValueOnce("cancelled");
  await render();
  await act(async () => resolveCatalog([item]));
  const search = container.querySelector('input[placeholder="Search apps"]') as HTMLInputElement;
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        search,
        value,
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === label);
  await type("tracker");
  await act(async () => button("Search more apps")?.click());
  await act(async () => button("Sign in")?.click());
  await type("");

  const rows = container.querySelectorAll('[data-testid="registered-mcp-server"]');
  expect([...rows].map((row) => row.textContent?.includes("Tracker"))).toContain(true);
});

it("shows the client form when a sign-in finds the provider needs one", async () => {
  const server = {
    id: "expired",
    slug: "expired-server",
    name: "Expired server",
    description: "",
    transport: "streamable_http",
    endpoint: "https://mcp.expired.example/mcp",
    headerKeys: [],
    enabled: true,
    hasSecret: false,
    oauthClientId: null,
    oauthStatus: "reconnect",
    health: {} as Record<string, unknown>,
  };
  const fallback = state.rpc.getMockImplementation();
  state.rpc.mockImplementation((proc: string, args: unknown) => {
    if (proc === "mcp/servers/list") return Promise.resolve([server]);
    if (proc === "integrationSetup/get")
      return Promise.resolve({ webUrl: "https://rakazo.example.test/integrations/setup" });
    return fallback?.(proc, args);
  });
  vi.mocked(signInToMcpServer).mockImplementationOnce(async () => {
    server.health = { status: "error", code: MCP_OAUTH_CLIENT_REQUIRED };
    throw new Error("Needs an OAuth client ID");
  });
  await render();
  expect(container.querySelector('[data-testid="mcp-oauth-client-form"]')).toBeNull();

  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((node) => node.textContent === "Reconnect")
      ?.click(),
  );

  expect(container.querySelector('[data-testid="mcp-oauth-client-form"]')).not.toBeNull();
});
