// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MobileDevicePresence } from "./mobile-device-presence";

const state = vi.hoisted(() => ({
  authorization: "",
  foreground: false,
  generation: 0,
  rpc: vi.fn(async () => ({ ok: true })),
}));

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => state.foreground }));
vi.mock("../api/session", () => ({
  currentReadySessionGeneration: () => state.generation,
  subscribeSessionGeneration: () => () => {},
}));
vi.mock("../api/api", () => ({
  currentApiBase: () => "https://example.test",
  subscribeApiBase: () => () => {},
  captureApiRequestContext: async () => ({
    apiBase: "https://example.test",
    sessionGeneration: state.generation,
    headers: { authorization: state.authorization },
  }),
  rpc: state.rpc,
}));

it("registers the signed-in phone when the app comes to the foreground", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = () => act(async () => root.render(<MobileDevicePresence ready />));
  try {
    state.foreground = true;
    await render();
    expect(state.rpc).not.toHaveBeenCalled();

    state.generation += 1;
    state.authorization = "Bearer fixture";
    state.foreground = false;
    await render();
    expect(state.rpc).not.toHaveBeenCalled();

    state.foreground = true;
    await render();
    expect(state.rpc).toHaveBeenCalledExactlyOnceWith(
      "mobileDevices/heartbeat",
      { platform: "android" },
      expect.objectContaining({
        requestContext: expect.objectContaining({ sessionGeneration: state.generation }),
      }),
    );
  } finally {
    await act(async () => root.unmount());
  }
});
