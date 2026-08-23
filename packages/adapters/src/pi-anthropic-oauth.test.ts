import type { AuthInteraction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createManualAnthropicOAuthLogin } from "./pi-anthropic-oauth.js";

describe("manual Anthropic OAuth", () => {
  it("runs concurrent paste-back flows without binding a callback port", async () => {
    const requests: RequestInit[] = [];
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return Response.json({
        access_token: `access-${requests.length}`,
        refresh_token: `refresh-${requests.length}`,
        expires_in: 3600,
      });
    }) as typeof fetch;
    let verifier = 0;
    const login = createManualAnthropicOAuthLogin({
      fetch: fakeFetch,
      createVerifier: () => `verifier-${++verifier}`,
    });

    const [first, second] = await Promise.all([
      login(interactionFor("code-one#verifier-1")),
      login(interactionFor("code-two#verifier-2")),
    ]);

    expect(first.access).toBe("access-1");
    expect(second.access).toBe("access-2");
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
      code: "code-one",
      state: "verifier-1",
      code_verifier: "verifier-1",
      redirect_uri: "http://localhost:53692/callback",
    });
  });

  it("rejects a pasted callback with the wrong OAuth state before exchange", async () => {
    let requested = false;
    const login = createManualAnthropicOAuthLogin({
      fetch: (async () => {
        requested = true;
        return Response.json({});
      }) as typeof fetch,
      createVerifier: () => "expected-state",
    });

    await expect(
      login(interactionFor("http://localhost:53692/callback?code=x&state=wrong-state")),
    ).rejects.toThrow(/state mismatch/i);
    expect(requested).toBe(false);
  });
});

function interactionFor(input: string): AuthInteraction {
  const signal = new AbortController().signal;
  return {
    signal,
    async prompt() {
      return input;
    },
    notify(event) {
      if (event.type === "auth_url") {
        expect(event.url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?/);
      }
    },
  };
}
