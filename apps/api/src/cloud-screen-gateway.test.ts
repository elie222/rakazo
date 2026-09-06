import { afterEach, expect, it, vi } from "vitest";
import gateway from "../../../infra/cloudflare/worker.js";
import { addScreenProxyCapability } from "./screen-proxy.js";

afterEach(() => vi.unstubAllGlobals());
it("serves viewer modules to opaque frames without forwarding application credentials", async () => {
  const secret = "test-screen-secret-at-least-32-characters";
  const url = addScreenProxyCapability(
    "https://computer.modal.host/embed.html?cadre_token=view&view_only=true",
    secret,
    "https://screen.example",
    undefined,
    { proxyExternal: true },
  );
  const fetcher = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("export default 1", {
        headers: { "content-type": "text/javascript", "set-cookie": "untrusted=yes" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const response = await gateway.fetch(
    new Request(url.replace("/embed.html", "/core/rfb.js"), {
      headers: { origin: "null", cookie: "app=session", authorization: "Bearer app-secret" },
    }),
    { SCREEN_PROXY_SECRET: secret, STORAGE_GATEWAY_TOKEN: secret, ARTIFACTS: {} as never },
  );
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("set-cookie")).toBeNull();
  const headers = fetcher.mock.calls[0]?.[1]?.headers as Headers;
  expect(headers.has("cookie")).toBe(false);
  expect(headers.has("authorization")).toBe(false);
  const denied = await gateway.fetch(
    new Request("https://screen.example/novnc/remote/view/0.invalid/core/rfb.js"),
    { SCREEN_PROXY_SECRET: secret, STORAGE_GATEWAY_TOKEN: secret, ARTIFACTS: {} as never },
  );
  expect(denied.status).toBe(403);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
