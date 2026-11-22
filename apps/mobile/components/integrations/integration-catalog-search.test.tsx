// @vitest-environment jsdom
import {
  CATALOG_SEARCH_QUERY_MAX_LENGTH,
  CATALOG_SEARCH_QUERY_MIN_LENGTH,
} from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { Mock } from "vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../../lib/query/query";
import { IntegrationCatalogSearch } from "./integration-catalog-search";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  announce: vi.fn(),
}));
vi.mock("../../lib/api/api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-fixture" },
  }),
  rpc: (proc: string, ...args: unknown[]) => state.rpc(proc, ...args),
}));
vi.mock("../../lib/api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../../lib/native/announce", () => ({ announceToScreenReader: state.announce }));
vi.mock("../../lib/appearance/appearance", () => ({
  mobileTokens: () => ({ destructive: "red", success: "green", warning: "orange" }),
}));
vi.mock("../../lib/native/native", () => ({
  native: {},
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./connector-icon", () => ({ ConnectorIcon: () => null }));
vi.mock("../native/native-action-button", () => ({
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

const catalogResult = {
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
};

let container: HTMLDivElement;
let root: Root;
let onChanged: Mock<(serverId?: string) => unknown>;

function view(props: { hidden?: boolean; query?: string } = {}) {
  return createElement(IntegrationCatalogSearch, {
    query: props.query ?? "tracker",
    hidden: props.hidden ?? false,
    noLocalMatch: true,
    onChanged,
    onOpenMcp: vi.fn(),
  });
}

async function press(label: string) {
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === label)
      ?.click();
  });
  await act(flush);
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  queryClient.clear();
  state.rpc.mockReset();
  state.announce.mockReset();
  onChanged = vi.fn<(serverId?: string) => unknown>();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it.each([CATALOG_SEARCH_QUERY_MIN_LENGTH - 1, CATALOG_SEARCH_QUERY_MAX_LENGTH + 1])(
  "keeps the local empty state without offering public search for %i characters",
  async (length) => {
    state.rpc.mockResolvedValue(catalogResult);
    await act(async () => root.render(view({ query: ` ${"x".repeat(length)} ` })));

    expect(container.textContent).toContain("No apps match your search.");
    expect(container.textContent).not.toContain("Search public MCP directory");
    expect(state.rpc).not.toHaveBeenCalled();
  },
);

it.each([CATALOG_SEARCH_QUERY_MIN_LENGTH, CATALOG_SEARCH_QUERY_MAX_LENGTH])(
  "searches the public catalog for a trimmed query of %i characters",
  async (length) => {
    const query = "x".repeat(length);
    state.rpc.mockResolvedValue(catalogResult);
    await act(async () => root.render(view({ query: ` ${query} ` })));
    await press("Search public MCP directory");

    expect(state.rpc).toHaveBeenCalledExactlyOnceWith(
      "capabilities/catalogSearch",
      { query, usePublicCatalog: true },
      expect.anything(),
    );
  },
);

it("reads out a failed catalog search once, and each new failure of it", async () => {
  state.rpc.mockImplementation(() => Promise.reject(new Error("Search is unavailable right now.")));
  await act(async () => root.render(view()));
  await press("Search public MCP directory");

  expect(container.textContent).toContain("Search is unavailable right now.");
  expect(state.announce).toHaveBeenCalledExactlyOnceWith("Search is unavailable right now.");

  await press("Search public MCP directory");
  expect(state.announce).toHaveBeenCalledTimes(2);
  expect(state.announce).toHaveBeenLastCalledWith("Search is unavailable right now.");
});

it("reads out a failed Connect once, in the text the screen shows", async () => {
  state.rpc.mockImplementation((proc: string) =>
    proc === "capabilities/catalogSearch"
      ? Promise.resolve(catalogResult)
      : Promise.reject(new Error("Tracker needs you to sign in again.")),
  );
  await act(async () => root.render(view()));
  await press("Search public MCP directory");
  await press("Connect");

  expect(container.textContent).toContain("Tracker needs you to sign in again.");
  expect(state.announce).toHaveBeenCalledExactlyOnceWith("Tracker needs you to sign in again.");
  expect(onChanged).toHaveBeenCalledWith(undefined);
});

it("reads out a Connect that fails after the component is hidden behind another category", async () => {
  const connect = deferred<never>();
  state.rpc.mockImplementation((proc: string) =>
    proc === "capabilities/catalogSearch" ? Promise.resolve(catalogResult) : connect.promise,
  );
  await act(async () => root.render(view()));
  await press("Search public MCP directory");
  await press("Connect");
  await act(async () => root.render(view({ hidden: true })));
  await act(async () => connect.reject(new Error("Tracker needs you to sign in again.")));
  await act(flush);

  expect(state.announce).toHaveBeenCalledExactlyOnceWith("Tracker needs you to sign in again.");
});

it("reads out a catalog search that fails after the component is hidden", async () => {
  const search = deferred<never>();
  state.rpc.mockImplementation(() => search.promise);
  await act(async () => root.render(view()));
  await press("Search public MCP directory");
  await act(async () => root.render(view({ hidden: true })));
  await act(async () => search.reject(new Error("Search is unavailable right now.")));
  await act(flush);

  expect(state.announce).toHaveBeenCalledExactlyOnceWith("Search is unavailable right now.");
});

it("does not read out a Connect that succeeds", async () => {
  state.rpc.mockImplementation((proc: string) =>
    proc === "capabilities/catalogSearch"
      ? Promise.resolve(catalogResult)
      : Promise.resolve({
          server: { id: "tracker-server", name: "Tracker", enabled: true },
          signIn: { status: "already_connected" },
        }),
  );
  await act(async () => root.render(view()));
  await press("Search public MCP directory");
  await press("Connect");

  expect(onChanged).toHaveBeenCalledWith("tracker-server");
  expect(state.announce).not.toHaveBeenCalled();
});
