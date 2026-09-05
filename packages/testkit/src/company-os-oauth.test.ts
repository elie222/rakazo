import { createHash, randomUUID } from "node:crypto";
import { createAuth } from "@rakazo/auth";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const suite = hasDb ? describe : describe.skip;
suite("Convex-backed Company OS OAuth login", () => {
  const origin = "http://localhost:5173";
  const issuer = "https://company.example";
  const email = `oauth-${randomUUID()}@example.test`;
  const config = { origin: issuer, clientId: "test-client", clientSecret: "test-client-secret" };
  let db: ReturnType<typeof createDb>;
  let auth: ReturnType<typeof createAuth>;
  let challenge = "";
  let exchanges = 0;
  const code = randomUUID();
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    auth = createAuth(db.prisma, {
      secret: "offline-auth-test-secret-at-least-32-characters",
      baseURL: origin,
      webOrigin: origin,
      signupsEnabled: "false",
      signupAllowlist: "",
      companyOsOAuth: config,
    });
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== issuer) return original(input, init);
      if (request.url.endsWith("/api/oauth/token")) {
        exchanges++;
        const form = new URLSearchParams(await request.text());
        expect(form.get("client_id")).toBe(config.clientId);
        expect(form.get("client_secret")).toBe(config.clientSecret);
        expect(form.get("redirect_uri")).toBe(`${origin}/api/auth/oauth2/callback/company-os`);
        expect(
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url"),
        ).toBe(challenge);
        if (exchanges > 1 || form.get("code") !== code)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "context:read context:write",
        });
      }
      if (request.url.endsWith("/api/oauth/userinfo")) {
        expect(request.headers.get("authorization")).toBe("Bearer test-access-token");
        return Response.json({
          sub: "verified-test-subject",
          name: "OAuth Test",
          email,
          email_verified: true,
          client_id: config.clientId,
          company: { id: "test-company", slug: "test-company", name: "Test Company" },
          capabilities: ["context:read", "context:write"],
        });
      }
      throw new Error("Unexpected OAuth endpoint");
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    const user = await db.prisma.user.findUnique({ where: { email } });
    if (user) {
      const members = await db.prisma.member.findMany({ where: { userId: user.id } });
      await db.prisma.organization.deleteMany({
        where: { id: { in: members.map((m) => m.organizationId) } },
      });
      await db.prisma.user.delete({ where: { id: user.id } });
    }
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  const start = (callbackURL = `${origin}/app`) =>
    auth.handler(
      new Request(`${origin}/api/auth/sign-in/oauth2`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "company-os",
          callbackURL,
          errorCallbackURL: `${origin}/login?error=oauth`,
        }),
      }),
    );
  it("refuses open redirects before contacting the identity provider", async () => {
    const response = await start("https://attacker.example/steal");
    expect(response.status).toBe(403);
    expect(exchanges).toBe(0);
  });
  it("rejects substituted state and issuer before exchanging a code", async () => {
    for (const tamper of ["state", "issuer"]) {
      const started = await start();
      const url = new URL((await started.json()).url);
      const cookie = started.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      const params = new URLSearchParams({
        code,
        state: tamper === "state" ? "substituted-state" : url.searchParams.get("state")!,
        iss: tamper === "issuer" ? "https://attacker.example" : issuer,
      });
      const response = await auth.handler(
        new Request(`${origin}/api/auth/oauth2/callback/company-os?${params}`, {
          headers: { cookie },
        }),
      );
      expect(response.headers.get("location")).not.toBe(`${origin}/app`);
      expect(exchanges).toBe(0);
    }
  });
  it("completes PKCE login, encrypts both tokens and refuses callback replay", async () => {
    const started = await start();
    expect(started.status).toBe(200);
    const authorize = new URL((await started.json()).url);
    expect(authorize.origin).toBe(issuer);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    challenge = authorize.searchParams.get("code_challenge")!;
    expect(challenge).toHaveLength(43);
    const cookie = started.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const callback = `${origin}/api/auth/oauth2/callback/company-os?${new URLSearchParams({ code, state: authorize.searchParams.get("state")!, iss: issuer })}`;
    const completed = await auth.handler(new Request(callback, { headers: { cookie } }));
    expect(completed.status).toBe(302);
    expect(completed.headers.get("location")).toBe(`${origin}/app`);
    const sessionCookie = completed.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const session = await auth.api.getSession({ headers: new Headers({ cookie: sessionCookie }) });
    expect(session?.user.email).toBe(email);
    expect(session?.user.emailVerified).toBe(true);
    const account = await db.prisma.account.findFirstOrThrow({
      where: { userId: session!.user.id, providerId: "company-os" },
    });
    expect(account.accessToken).not.toBe("test-access-token");
    expect(account.refreshToken).not.toBe("test-refresh-token");
    const replay = await auth.handler(new Request(callback, { headers: { cookie } }));
    expect(replay.headers.get("location")).not.toBe(`${origin}/app`);
    expect(exchanges).toBe(1);
  });
});
