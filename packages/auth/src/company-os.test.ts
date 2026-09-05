import { describe, expect, it, vi } from "vitest";
import {
  companyOsIdentity,
  companyOsOAuthFromEnv,
  companyOsSubject,
  createCompanyOsCredential,
} from "./company-os.js";

const config = {
  origin: "https://company.example",
  clientId: "test-client",
  clientSecret: "test-secret",
};
const profile = {
  sub: "user-one",
  name: "Example",
  email: "member@example.com",
  email_verified: true,
  client_id: config.clientId,
  company: { id: "company-one", name: "Example Co", slug: "example" },
  capabilities: ["context:read", "context:write"],
};
describe("Company OS OAuth boundary", () => {
  it("pins the origin and refuses missing credentials or unsafe origins", () => {
    expect(companyOsOAuthFromEnv({})).toBeUndefined();
    for (const origin of [
      "http://company.example",
      "https://user:secret@company.example",
      "https://company.example/path",
      "https://company.example?other=true",
    ])
      expect(() =>
        companyOsOAuthFromEnv({
          AUTH_PROVIDER: "convex-company-os",
          COMPANY_OS_OAUTH_ORIGIN: origin,
          COMPANY_OS_OAUTH_CLIENT_ID: "id",
          COMPANY_OS_OAUTH_CLIENT_SECRET: "secret",
        }),
      ).toThrow();
    expect(() => companyOsOAuthFromEnv({ AUTH_PROVIDER: "convex-company-os" })).toThrow();
  });
  it("uses the verified subject, never an email as the provider identity", () => {
    expect(companyOsSubject(config, profile.sub)).toBe(companyOsSubject(config, profile.sub));
    expect(companyOsSubject(config, profile.sub)).not.toBe(
      companyOsSubject({ ...config, origin: "https://other.example" }, profile.sub),
    );
  });
  it("requires a verified, client-bound identity and never follows redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(profile));
    expect(await companyOsIdentity(config, "access-test", fetcher)).toEqual(profile);
    expect(fetcher).toHaveBeenCalledWith(
      "https://company.example/api/oauth/userinfo",
      expect.objectContaining({
        redirect: "error",
        cache: "no-store",
        headers: { authorization: "Bearer access-test" },
      }),
    );
    for (const change of [
      { email_verified: false },
      { client_id: "other-client" },
      { sub: "" },
      { company: null },
      { capabilities: [1] },
    ])
      await expect(
        companyOsIdentity(
          config,
          "access-test",
          vi.fn().mockResolvedValue(Response.json({ ...profile, ...change })),
        ),
      ).rejects.toThrow();
    await expect(
      companyOsIdentity(
        config,
        "access-test",
        vi.fn().mockResolvedValue(new Response("secret provider detail", { status: 401 })),
      ),
    ).rejects.toThrow("authorization is unavailable");
  });
  it("releases the distributed refresh lock when token refresh fails", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const release = vi.fn();
    const auth = {
      api: { getAccessToken: vi.fn().mockRejectedValue(new Error("provider unavailable")) },
    };
    const resolve = createCompanyOsCredential(auth as never, config, {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as never);
    await expect(resolve("user-one")).rejects.toThrow("provider unavailable");
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
    ]);
    expect(auth.api.getAccessToken).toHaveBeenCalledWith({
      body: { providerId: "company-os", userId: "user-one" },
    });
    expect(release).toHaveBeenCalledOnce();
  });
});
