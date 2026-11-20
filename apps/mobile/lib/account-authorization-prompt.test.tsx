// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  generation: 1,
  path: "/",
  token: "fake-token",
  config: { enabled: true, modelAccountOnly: true },
  status: { enabled: true, connected: false },
  push: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === "config" ? state.config : state.status,
  }),
}));
vi.mock("expo-router", () => ({
  usePathname: () => state.path,
  useRouter: () => ({ push: state.push }),
}));
vi.mock("./api/api", () => ({ currentApiBase: () => "https://app.example.test" }));
vi.mock("./query/query", () => ({ queryClient: {} }));
vi.mock("./api/session", () => ({
  currentSessionGeneration: () => state.generation,
  subscribeSessionGeneration: () => () => {},
  loadSessionToken: async () => state.token,
}));
vi.mock("./model-account-client", () => ({
  modelAccountConfigQuery: () => ({ queryKey: ["config"] }),
  modelAccountStatusQuery: () => ({ queryKey: ["status"] }),
}));

import { AccountAuthorizationPrompt } from "../components/account-authorization-prompt";

it("pushes the native account screen once, preserves back navigation and skips sign-out", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = () => act(async () => root.render(<AccountAuthorizationPrompt />));
  try {
    await render();
    expect(state.push).toHaveBeenCalledWith("/(settings)/model-account");
    expect(state.push).toHaveBeenCalledOnce();
    await render();
    expect(state.push).toHaveBeenCalledOnce();
    state.status = { enabled: true, connected: true };
    await render();
    state.status = { enabled: true, connected: false };
    state.path = "/model-account";
    await render();
    expect(state.push).toHaveBeenCalledOnce();
    state.path = "/thread";
    await render();
    expect(state.push).toHaveBeenCalledOnce();
    state.generation++;
    state.token = "";
    await render();
    expect(state.push).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
