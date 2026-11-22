// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const complete = vi.hoisted(() => vi.fn());

vi.mock("../../lib/query/rpc", () => ({ rpc: { connections: { complete } } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { APP_CONNECT_WINDOW_NAME } from "../../lib/integrations/app-connect";
import { IntegrationCallbackPage } from "./IntegrationCallback";

afterEach(() => {
  document.body.innerHTML = "";
  window.name = "";
  window.sessionStorage.clear();
  complete.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(pathname: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const location = { pathname, search: "?status=success", replace: vi.fn() };
  vi.stubGlobal("location", location);
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => createRoot(container).render(<IntegrationCallbackPage />));
  return { location, close };
}

it("finishes the connection itself, then closes the card's popup", async () => {
  complete.mockResolvedValue({ status: "connected" });
  window.name = APP_CONNECT_WINDOW_NAME;
  window.sessionStorage.setItem("rakazo:app-connect-return:connection-1", "/app/bot");
  const { location, close } = await render("/integrations/callback/connection-1");
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(complete).toHaveBeenCalledWith({ connectionId: "connection-1" }, expect.anything());
  expect(location.replace).not.toHaveBeenCalled();
});

it("returns a tab that left for the sign-in to its chat", async () => {
  complete.mockResolvedValue({ status: "connected" });
  window.sessionStorage.setItem("rakazo:app-connect-return:connection-1", "/app/bot");
  const { location, close } = await render("/integrations/callback/connection-1");
  await vi.waitFor(() => expect(location.replace).toHaveBeenCalledWith("/app/bot"));
  expect(close).not.toHaveBeenCalled();
});

it("hands a sign-in the mobile app started back to the app without finishing it", async () => {
  const { location, close } = await render("/integrations/callback/connection-1/mobile");
  expect(location.replace).toHaveBeenCalledWith("rakazo://app-connect?connection=connection-1");
  expect(complete).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});
