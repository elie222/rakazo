import { describe, expect, it } from "vitest";
import { crossSiteCookieRequest } from "./rpc-route.js";

const env = {
  webOrigin: "https://app.example.test",
  apiUrl: "https://api.example.test",
  authUrl: "https://app.example.test",
};

function rpcRequest(headers: Record<string, string>) {
  return new Request("https://api.example.test/rpc/me", { method: "POST", headers });
}

describe("crossSiteCookieRequest", () => {
  it("refuses a cookie request from an untrusted page", () => {
    const request = rpcRequest({ cookie: "session=1", origin: "https://www.example.test" });
    expect(crossSiteCookieRequest(request, env)).toBe(true);
  });

  it("accepts a cookie request from the app or with no origin", () => {
    expect(
      crossSiteCookieRequest(
        rpcRequest({ cookie: "session=1", origin: "https://app.example.test" }),
        env,
      ),
    ).toBe(false);
    expect(crossSiteCookieRequest(rpcRequest({ cookie: "session=1" }), env)).toBe(false);
  });

  it("leaves bearer and cookieless requests to their own checks", () => {
    const origin = "https://www.example.test";
    expect(
      crossSiteCookieRequest(
        rpcRequest({ cookie: "session=1", origin, authorization: "Bearer token" }),
        env,
      ),
    ).toBe(false);
    expect(crossSiteCookieRequest(rpcRequest({ origin }), env)).toBe(false);
  });
});
