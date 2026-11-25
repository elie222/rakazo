import { afterEach, describe, expect, it, vi } from "vitest";
import { createManualOpenAIOAuthLogin } from "./openai-oauth.js";

afterEach(() => vi.unstubAllEnvs());

function signInWith(token: Response) {
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  let authorizeUrl = "";
  const login = createManualOpenAIOAuthLogin({
    verifier: "saved-verifier",
    fetch: async () => token,
  });
  return login({
    signal: new AbortController().signal,
    notify(event) {
      if (event.type === "auth_url") authorizeUrl = event.url;
    },
    async prompt() {
      const state = new URL(authorizeUrl).searchParams.get("state");
      return `http://127.0.0.1:1455/auth/callback?code=grant-code&state=${state}&client_id=issued-client`;
    },
  });
}

describe("manual ChatGPT browser sign-in", () => {
  it("exchanges a registered callback with the original verifier and issued client ID", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
    const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("client_id")).toBe("issued-client");
      expect(body.get("code_verifier")).toBe("saved-verifier");
      expect(body.get("code")).toBe("grant-code");
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        id_token: "id",
        scope: "resource.invoke chatgpt.tokens.use.direct",
        expires_in: 3600,
      });
    });
    let authorizeUrl = "";
    const login = createManualOpenAIOAuthLogin({ verifier: "saved-verifier", fetch: request });
    const credential = await login({
      signal: new AbortController().signal,
      notify(event) {
        if (event.type === "auth_url") authorizeUrl = event.url;
      },
      async prompt() {
        const state = new URL(authorizeUrl).searchParams.get("state");
        return `http://127.0.0.1:1455/auth/callback?code=grant-code&state=${state}&client_id=issued-client`;
      },
    });
    const authorization = new URL(authorizeUrl);
    expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorization.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(authorization.searchParams.get("state")).not.toBe("saved-verifier");
    expect(credential).toMatchObject({
      type: "oauth",
      access: "access",
      refresh: "refresh",
      clientId: "issued-client",
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects a callback with a different state before exchanging the code", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
    const request = vi.fn();
    const login = createManualOpenAIOAuthLogin({ verifier: "saved-verifier", fetch: request });
    await expect(
      login({
        signal: new AbortController().signal,
        notify() {},
        async prompt() {
          return "http://127.0.0.1:1455/auth/callback?code=grant-code&state=wrong&client_id=issued-client";
        },
      }),
    ).rejects.toThrow("OAuth state mismatch.");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a callback from a different redirect origin", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
    const request = vi.fn();
    const login = createManualOpenAIOAuthLogin({ verifier: "saved-verifier", fetch: request });
    await expect(
      login({
        signal: new AbortController().signal,
        notify() {},
        async prompt() {
          return "https://example.com/auth/callback?code=grant-code&client_id=issued-client";
        },
      }),
    ).rejects.toThrow("The pasted callback URL is not from the ChatGPT sign-in redirect.");
    expect(request).not.toHaveBeenCalled();
  });

  it("requires the issued client ID returned by registration", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
    const request = vi.fn();
    let authorizeUrl = "";
    const login = createManualOpenAIOAuthLogin({ verifier: "saved-verifier", fetch: request });
    await expect(
      login({
        signal: new AbortController().signal,
        notify(event) {
          if (event.type === "auth_url") authorizeUrl = event.url;
        },
        async prompt() {
          const state = new URL(authorizeUrl).searchParams.get("state");
          return `http://127.0.0.1:1455/auth/callback?code=grant-code&state=${state}`;
        },
      }),
    ).rejects.toThrow("ChatGPT callback is missing its code or issued client ID.");
    expect(request).not.toHaveBeenCalled();
  });

  it("takes a token response without scope as granting the requested scopes", async () => {
    const credential = await signInWith(
      Response.json({
        access_token: "access",
        refresh_token: "refresh",
        id_token: "id",
        expires_in: 3600,
      }),
    );
    expect(credential.scopes).toContain("chatgpt.tokens.use.direct");
  });

  it("reports a token response that is not JSON as invalid", async () => {
    await expect(signInWith(new Response("<html>bad gateway</html>"))).rejects.toThrow(
      "ChatGPT token response is invalid.",
    );
  });
});
