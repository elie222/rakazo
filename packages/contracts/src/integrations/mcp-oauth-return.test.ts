import { describe, expect, it } from "vitest";
import { MOBILE_MCP_OAUTH_STATE_PREFIX, mobileMcpOAuthReturnUrl } from "./mcp-oauth-return.js";

describe("mobileMcpOAuthReturnUrl", () => {
  it("hands a sign-in the app started back to the app with the provider's answer", () => {
    const state = `${MOBILE_MCP_OAUTH_STATE_PREFIX}session-1`;
    const url = new URL(mobileMcpOAuthReturnUrl(new URLSearchParams({ code: "code-1", state }))!);

    expect(`${url.protocol}//${url.host}`).toBe("rakazo://mcp-oauth");
    expect(url.searchParams.get("code")).toBe("code-1");
    expect(url.searchParams.get("state")).toBe(state);
  });

  it("returns a refused sign-in to the app so it can close the browser", () => {
    const params = new URLSearchParams({
      error: "access_denied",
      state: `${MOBILE_MCP_OAUTH_STATE_PREFIX}session-1`,
    });

    expect(new URL(mobileMcpOAuthReturnUrl(params)!).searchParams.get("error")).toBe(
      "access_denied",
    );
  });

  it("leaves a browser sign-in to the browser", () => {
    expect(mobileMcpOAuthReturnUrl(new URLSearchParams({ code: "c", state: "session-1" }))).toBe(
      null,
    );
    expect(mobileMcpOAuthReturnUrl(new URLSearchParams({ error: "access_denied" }))).toBe(null);
  });
});
