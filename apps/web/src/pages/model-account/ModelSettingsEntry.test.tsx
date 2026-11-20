// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  me: {
    data: undefined as { modelAccountOnly?: boolean } | undefined,
    error: null as Error | null,
  },
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => state.me }));
vi.mock("../../lib/query/query", () => ({
  useSpaceQueries: () => ({ me: { queryKey: () => ["me"] } }),
}));
vi.mock("../../lib/query/space-rpc", () => ({ useSpaceRpc: () => ({ me: vi.fn() }) }));
vi.mock("../../components/PageLoading", () => ({ PageLoading: () => <p>Loading</p> }));
vi.mock("./ModelAccountSettings", () => ({
  ModelAccountSettings: ({ scope }: { scope: string }) => <p>Account {scope}</p>,
}));

import { ModelSettingsEntry } from "./ModelSettingsEntry";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
it("waits for policy, handles errors and selects the account or upstream page", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = (node: ReactNode) => act(() => root.render(node));
  try {
    render(
      <ModelSettingsEntry fallback={<p>Ordinary</p>} scope="space" onClose={() => undefined} />,
    );
    expect(host.textContent).toBe("Loading");
    state.me.error = new Error("offline");
    render(
      <ModelSettingsEntry fallback={<p>Ordinary</p>} scope="space" onClose={() => undefined} />,
    );
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Ordinary");
    state.me = { data: { modelAccountOnly: true }, error: null };
    render(
      <ModelSettingsEntry fallback={<p>Ordinary</p>} scope="space" onClose={() => undefined} />,
    );
    expect(host.textContent).toBe("Account space");
    state.me.data = { modelAccountOnly: false };
    render(
      <ModelSettingsEntry fallback={<p>Ordinary</p>} scope="account" onClose={() => undefined} />,
    );
    expect(host.textContent).toBe("Ordinary");
  } finally {
    act(() => root.unmount());
  }
});
