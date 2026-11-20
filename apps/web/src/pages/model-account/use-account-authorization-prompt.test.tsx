// @vitest-environment jsdom

import type { ModelAccountConfig, ModelAccountStatus } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: { enabled: true, modelAccountOnly: true } as ModelAccountConfig,
  status: { enabled: true, connected: false, linked: true } as ModelAccountStatus,
  session: "fixture-session",
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === "config" ? state.config : state.status,
  }),
}));
vi.mock("../../lib/auth/auth", () => ({
  authClient: { useSession: () => ({ data: { session: { id: state.session } } }) },
}));
vi.mock("./queries", () => ({
  modelAccountConfigQuery: { queryKey: ["config"] },
  modelAccountStatusQuery: () => ({ queryKey: ["status"] }),
}));

import { useAccountAuthorizationPrompt } from "./use-account-authorization-prompt";

it("opens authorization directly, allows dismissal, and reopens after a new authorization requirement", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const open = vi.fn();
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  function Page({ visible = false }: { visible?: boolean }) {
    useAccountAuthorizationPrompt("fixture-user", open, visible);
    return <p>Saved conversation and draft</p>;
  }
  const render = (visible = false) => act(() => root.render(<Page visible={visible} />));
  try {
    render();
    expect(open).toHaveBeenCalledOnce();
    render();
    expect(open).toHaveBeenCalledOnce();
    state.status = { enabled: true, connected: true };
    render();
    state.status = { enabled: true, connected: true, recovery: "authorization_required" };
    render(true);
    expect(open).toHaveBeenCalledOnce();
    render();
    expect(open).toHaveBeenCalledOnce();
    state.session = "new-fixture-session";
    render();
    expect(open).toHaveBeenCalledTimes(2);
    state.config = { enabled: true, modelAccountOnly: false };
    state.session = "ordinary-session";
    render();
    expect(open).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe("Saved conversation and draft");
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
