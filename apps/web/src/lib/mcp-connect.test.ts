// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const begin = vi.hoisted(() => vi.fn());
vi.mock("./rpc", () => ({ rpc: { mcp: { oauth: { begin } } } }));

import { connectMcpOauth, consumeMcpOAuthReturnPath, mcpOAuthReturnPath } from "./mcp-connect";

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
  begin.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("retains only a fixed marketplace return intent while sign-in is pending", async () => {
  const popup = { closed: false, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage: unknown;
      close() {}
    },
  );
  begin.mockResolvedValue({
    status: "authorization_required",
    authorizationUrl: "https://auth.example.test/authorize",
    sessionId: "session-test",
  });
  const result = connectMcpOauth("server-test", { returnToMarketplace: true });
  await Promise.resolve();
  expect(mcpOAuthReturnPath()).toBe("/app?marketplace=installed");
  expect(mcpOAuthReturnPath()).toBe("/app?marketplace=installed");
  popup.closed = true;
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toBe("cancelled");
  expect(mcpOAuthReturnPath()).toBe("/app");
});
it("does not interpret stored content as an arbitrary redirect URL", () => {
  window.sessionStorage.setItem("rakazo:mcp-marketplace-return", "https://other.example.test");
  expect(consumeMcpOAuthReturnPath()).toBe("/app");
  window.sessionStorage.setItem("rakazo:mcp-marketplace-return", "1");
  expect(consumeMcpOAuthReturnPath()).toBe("/app?marketplace=installed");
  expect(mcpOAuthReturnPath()).toBe("/app");
});
it("does not open a popup or change return intent when the server needs no authorization", async () => {
  const open = vi.spyOn(window, "open");
  begin.mockResolvedValue({ status: "authorization_not_requested" });
  expect(await connectMcpOauth("public-server", { returnToMarketplace: true })).toBe(
    "authorization_not_requested",
  );
  expect(open).not.toHaveBeenCalled();
  expect(mcpOAuthReturnPath()).toBe("/app");
});
