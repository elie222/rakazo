// @vitest-environment jsdom
import type { CapabilityInstall } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ManageView } from "./manage-view";
import type { TileContext } from "./parts";
import type { PluginConnections } from "./use-plugin-connections";

vi.mock("./parts", () => ({
  CatalogTile: () => null,
  ConnectionStatus: () => null,
  ConnectorIcon: () => null,
  ViewTitle: () => null,
}));
vi.mock("../../components/integrations/plugin-marketplace", () => ({
  PluginLogo: () => null,
  ROW_BUTTON: "",
  ROW_HOVER: "",
  ROW_SHELL: "",
}));
vi.mock("../../components/integrations/space-availability", () => ({
  AvailabilityControl: () => null,
  AvailabilityLabel: () => null,
}));
vi.mock("@lingui/react/macro", () => ({
  Plural: () => null,
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", async () => {
  const { createElement } = await import("react");
  return {
    Button: ({
      children,
      onClick,
      disabled,
      type,
      "aria-describedby": describedBy,
    }: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
      type?: "button" | "submit";
      "aria-describedby"?: string;
    }) =>
      createElement(
        "button",
        { type: type ?? "button", onClick, disabled, "aria-describedby": describedBy },
        children,
      ),
  };
});

function source(id: string, name: string): CapabilityInstall {
  return {
    id,
    name,
    kind: "api",
    source: "https://example.test/openapi.json",
  } as CapabilityInstall;
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("names each Remove button after the source it removes", () => {
  const sources = [source("src-billing", "Billing API"), source("src-docs", "Docs GraphQL")];
  const state = {
    mcpError: null,
    mcpQuery: { refetch: vi.fn() },
    sources,
    pending: null,
    refresh: vi.fn(),
  } as unknown as PluginConnections;

  act(() => {
    root.render(
      <ManageView
        state={state}
        tileContext={{} as TileContext}
        connectedItems={[]}
        connectorInstalls={[]}
        standaloneServers={[]}
        appCount={sources.length}
        sourceError={null}
        confirmingSource={null}
        onRemoveSource={vi.fn()}
        installedSelection={vi.fn()}
        pluginServers={() => []}
        onOpenPlugin={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  });

  const removeButtons = [...host.querySelectorAll("button")].filter(
    (button) => button.textContent === "Remove",
  );
  const described = removeButtons.map((button) => {
    const id = button.getAttribute("aria-describedby") ?? "";
    return document.getElementById(id)?.textContent;
  });
  expect(described).toEqual(["Billing API", "Docs GraphQL"]);
});
