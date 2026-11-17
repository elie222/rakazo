// @vitest-environment jsdom

import type { ModelCredential } from "@rakazo/contracts";
import { QueryClient, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSpaceQueries } from "../../lib/query";
import { createQueryRoot } from "../../lib/query-root.test-support";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  ModelSettingsFields: ({
    maxTokens,
    onMaxTokensChange,
  }: {
    maxTokens: string;
    onMaxTokensChange: (value: string) => void;
  }) => (
    <>
      <output>{maxTokens}</output>
      <button type="button" onClick={() => onMaxTokensChange("2048")}>
        Edit
      </button>
    </>
  ),
}));

const client = vi.hoisted(() => ({
  models: {
    credentials: vi.fn(),
    list: vi.fn(async () => []),
    saveModelSettings: vi.fn(async () => ({ ok: true as const })),
  },
}));
vi.mock("../../lib/rpc", () => ({
  rpc: client,
  rpcForSpace: () => client,
  createSpaceRpc: () => client,
  selectedSpaceId: () => null,
}));

import { ModelSettingsPanel } from "./model-settings-panel";

const credential = {
  id: "connection-1",
  provider: "provider-a",
  label: "Connection",
  hasKey: true,
  isDefault: true,
} as ModelCredential;

function Panel() {
  const queries = useSpaceQueries();
  const saved = useQuery(queries.models.credentials.queryOptions()).data?.[0];
  return saved ? (
    <ModelSettingsPanel credential={saved} modelId="model-1" entry={undefined} />
  ) : null;
}

let host: HTMLDivElement;
let root: ReturnType<typeof createQueryRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createQueryRoot(host, new QueryClient({ defaultOptions: { queries: { retry: false } } }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = (label: string) =>
  [...host.querySelectorAll("button")].find((node) => node.textContent === label);

it("keeps showing what was saved when reading the connections again fails", async () => {
  client.models.credentials
    .mockResolvedValueOnce([credential])
    .mockRejectedValue(new Error("offline"));
  await act(async () => root.render(<Panel />));

  await vi.waitFor(() => expect(button("Edit")).toBeDefined());
  await act(async () => button("Edit")?.click());
  await act(async () => button("Save")?.click());
  await vi.waitFor(() => expect(host.querySelector('[role="status"]')?.textContent).toBe("Saved."));

  expect(client.models.saveModelSettings).toHaveBeenCalledWith({
    credentialId: "connection-1",
    modelId: "model-1",
    settings: { images: false, maxTokens: 2048, reasoning: false },
  });
  expect(client.models.credentials).toHaveBeenCalledTimes(2);
  expect(host.querySelector("output")?.textContent).toBe("2048");
  expect(button("Save")).toBeUndefined();
});
