// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  route: "models",
  params: { spaceId: "space-fixture" } as { spaceId?: string; requestId?: string },
  me: {
    data: undefined as { modelAccountOnly?: boolean } | undefined,
    error: null as Error | null,
    refetch: vi.fn(),
  },
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => state.me }));
vi.mock("./model-account-client", () => ({ modelAccountConfigQuery: () => ({}) }));
vi.mock("./query/query", () => ({ queryClient: {}, rpcQuery: () => ({}) }));
vi.mock("./i18n/i18n", () => ({
  useI18n: () => ({ t: (text: string) => text }),
  t: (text: string) => text,
}));
vi.mock("react-native", () => ({ ActivityIndicator: () => <p>Loading</p> }));
vi.mock("../components/ui/load-failure", () => ({ LoadFailure: () => <p role="alert">Failed</p> }));
vi.mock("expo-router", () => ({
  useSegments: () => ["(settings)", state.route],
  useLocalSearchParams: () => state.params,
  Redirect: ({ href }: { href: unknown }) => <output>{JSON.stringify(href)}</output>,
}));

import { ModelAccountRoutes } from "../components/model-account-routes";
import { closeModelConnection, openModelConnection } from "./models/model-connection-request";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
it("blocks old model routes until policy is known and preserves space on redirect", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = () =>
    act(() =>
      root.render(
        <ModelAccountRoutes>
          <p>Ordinary</p>
        </ModelAccountRoutes>,
      ),
    );
  try {
    render();
    expect(host.textContent).toBe("Loading");
    state.me.error = new Error("offline");
    render();
    expect(host.textContent).toBe("Failed");
    state.me = { ...state.me, data: { modelAccountOnly: true }, error: null };
    for (const route of ["models", "model-connection"]) {
      state.route = route;
      render();
      expect(JSON.parse(host.querySelector("output")!.textContent!)).toEqual({
        pathname: "/model-account",
        params: { spaceId: "space-fixture" },
      });
      expect(host.textContent).not.toContain("Ordinary");
    }
    const requestId = openModelConnection({
      provider: "fixture",
      credentialId: null,
      makeDefault: false,
      target: { scope: "space", spaceId: "other-space" },
    });
    state.route = "model-connection";
    state.params = { requestId };
    render();
    expect(JSON.parse(host.querySelector("output")!.textContent!)).toEqual({
      pathname: "/model-account",
      params: { spaceId: "other-space" },
    });
    closeModelConnection(requestId);
    state.me.data = { modelAccountOnly: false };
    render();
    expect(host.textContent).toBe("Ordinary");
    state.route = "language";
    state.me.data = undefined;
    render();
    expect(host.textContent).toBe("Ordinary");
  } finally {
    act(() => root.unmount());
  }
});
