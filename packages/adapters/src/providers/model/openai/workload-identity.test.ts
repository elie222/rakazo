import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { exchangeWorkloadIdentity } from "./workload-identity.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const binding = {
  tokenFile: "fixture-token",
  identityProviderId: "fixture-provider",
  serviceAccountId: "fixture-account",
};

describe("workload identity exchange", () => {
  it("exchanges the mounted assertion for an expiring inference credential", async () => {
    vi.mocked(readFile).mockResolvedValue("fixture-assertion\n");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ access_token: "fixture-bearer", expires_in: 600 }));
    const token = await exchangeWorkloadIdentity(binding, new AbortController().signal, fetcher);
    expect(token.key).toBe("fixture-bearer");
    expect(token.expiresAt).toBeGreaterThan(Date.now());
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(options?.redirect).toBe("error");
    expect(JSON.parse(String(options?.body))).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: "fixture-assertion",
      identity_provider_id: "fixture-provider",
      service_account_id: "fixture-account",
    });
  });

  it("reports a token service outage without exposing its response", async () => {
    vi.mocked(readFile).mockResolvedValue("fixture-assertion");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ detail: "fixture-assertion" }, { status: 503 }));
    await expect(
      exchangeWorkloadIdentity(binding, new AbortController().signal, fetcher),
    ).rejects.toMatchObject({
      kind: "SERVICE_UNAVAILABLE",
      message: "The OpenAI token service is unavailable.",
    });
  });

  it("does not surface a rejected provider response with credentials in it", async () => {
    vi.mocked(readFile).mockResolvedValue("fixture-assertion");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ detail: "fixture-assertion" }, { status: 401 }));
    await expect(
      exchangeWorkloadIdentity(binding, new AbortController().signal, fetcher),
    ).rejects.toThrow(/^Model OAuth exchange failed. Check the workload identity binding\.$/);
  });
});
