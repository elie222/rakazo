import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type * as Db from "@rakazo/db";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Auth, AuthEnv } from "./index.js";
import { createAuth } from "./index.js";
import { isCurrentOidcAccount, oidcAccountSubject } from "./oidc.js";

const state = vi.hoisted(() => ({ db: {} as Record<string, Record<string, unknown>[]> }));
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: () => memoryAdapter(state.db) }));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  bootstrapUserSpace: vi.fn(),
}));

const issuer = "https://identity.example.test";
const origin = "https://rakazo.example.test";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
let auth: Auth;
let discoveryDown: boolean;
let activeIssuer = issuer;
let sequence: number;
let cookies: string;
let sentCodes: string[];
let corruptSignature = false;
let omitIdToken = false;
const codes = new Map<
  string,
  { challenge: string; nonce: string; claims: Record<string, unknown> }
>();

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}
function jwt(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: activeIssuer,
      aud: "test-client",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(corruptSignature ? `${data}tampered` : data), privateKey).toString("base64url")}`;
}

function setup(options: Partial<AuthEnv> = {}) {
  const prisma: Record<string, unknown> = {
    deploymentSettings: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    spaceMember: { findFirst: vi.fn(async () => ({ id: "existing-space" })) },
    member: { findMany: vi.fn(async () => []) },
    messagingIdentity: { deleteMany: vi.fn(async () => ({})) },
    organization: { deleteMany: vi.fn(async () => ({})) },
  };
  prisma.$transaction = vi.fn(async (operations: (tx: unknown) => Promise<unknown>) =>
    operations(prisma),
  );
  auth = createAuth(prisma as never, {
    secret: "offline-test-secret-with-at-least-32-characters",
    baseURL: origin,
    webOrigin: origin,
    signupsEnabled: "true",
    signupAllowlist: undefined,
    email: {
      describe: () => ({
        id: "offline-email",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { transactional: true },
      }),
      send: vi.fn(async (message) => {
        sentCodes.push(message.text);
      }),
    },
    oidc: {
      issuer,
      clientId: "test-client",
      clientSecret: "test-client-secret",
      name: "SSO",
      scopes: ["openid", "email", "profile"],
      allowSignupBypass: false,
    },
    ...options,
  });
}

async function request(path: string, body?: unknown, bearer?: string) {
  const response = await auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(cookies ? { cookie: cookies } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const cookieList = response.headers.getSetCookie();
  const jar = new Map(
    cookies
      .split("; ")
      .filter(Boolean)
      .map((item) => item.split("=") as [string, string]),
  );
  for (const cookie of cookieList) {
    const [key, value] = cookie.split(";")[0]!.split("=");
    if (key) jar.set(key, value ?? "");
  }
  cookies = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  return response;
}

async function start(
  claims: Record<string, unknown> = {
    sub: "subject-1",
    email: "sso@example.test",
    email_verified: true,
    name: "SSO user",
  },
  link = false,
  callbackURL = `${origin}/app`,
  reauthenticate = false,
) {
  const response = await request(link ? "/link-social" : "/sign-in/social", {
    provider: "oidc",
    callbackURL,
    errorCallbackURL: `${origin}/sign-in`,
    disableRedirect: true,
    ...(reauthenticate ? { additionalData: { reauthenticate: true } } : {}),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const url = new URL(((await response.json()) as { url: string }).url);
  const code = `code-${++sequence}`;
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("prompt")).toBe("login");
  codes.set(code, {
    challenge: url.searchParams.get("code_challenge")!,
    nonce: url.searchParams.get("nonce")!,
    claims,
  });
  return `/callback/oidc?state=${url.searchParams.get("state")}&code=${code}`;
}
async function signIn(claims?: Record<string, unknown>) {
  return request(await start(claims));
}
const rows = (model: string) => state.db[model] ?? [];

function expireOidcProofs() {
  for (const value of rows("verification")) {
    if (String(value.identifier).startsWith("oidc-reauth-")) value.expiresAt = new Date(0);
  }
}

beforeEach(() => {
  state.db = {
    user: [],
    session: [],
    account: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
  };
  discoveryDown = false;
  activeIssuer = issuer;
  sequence = 0;
  cookies = "";
  sentCodes = [];
  corruptSignature = false;
  omitIdToken = false;
  codes.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== activeIssuer) throw new Error("Unexpected offline request");
      if (url.pathname.endsWith("openid-configuration"))
        return discoveryDown
          ? json({}, 503)
          : json({
              issuer: activeIssuer,
              authorization_endpoint: `${activeIssuer}/authorize`,
              token_endpoint: `${activeIssuer}/token`,
              userinfo_endpoint: `${activeIssuer}/userinfo`,
              jwks_uri: `${activeIssuer}/jwks`,
              id_token_signing_alg_values_supported: ["RS256"],
            });
      if (url.pathname === "/jwks") return json({ keys: [jwk] });
      if (url.pathname === "/token") {
        const body = new URLSearchParams(String(init?.body));
        const code = body.get("code")!;
        const value = codes.get(code);
        codes.delete(code);
        const challenge = createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url");
        if (!value || value.challenge !== challenge) return json({ error: "invalid_grant" }, 400);
        return json({
          access_token: "fake-access-token",
          token_type: "Bearer",
          expires_in: 300,
          ...(omitIdToken ? {} : { id_token: jwt({ ...value.claims, nonce: value.nonce }) }),
        });
      }
      throw new Error("Unexpected OIDC route");
    }),
  );
});
afterEach(() => {
  auth?.disposeOidcDiscovery();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OIDC callbacks", () => {
  it.each([true, false, undefined])(
    "preserves email_verified=%s through the real callback",
    async (verified) => {
      setup();
      const response = await signIn({
        sub: "subject-1",
        email: "sso@example.test",
        ...(verified === undefined ? {} : { email_verified: verified }),
      });
      expect(response.headers.get("location")).toBe(`${origin}/app`);
      expect(rows("user")).toHaveLength(1);
      expect(rows("user")[0]?.emailVerified).toBe(verified === true);
      expect(rows("account")).toHaveLength(1);
    },
  );
  it.each([false, undefined])(
    "downgrades a previously verified OIDC email when the claim becomes %s",
    async (verified) => {
      setup();
      await signIn();
      await signIn({ sub: "subject-1", email: "sso@example.test", email_verified: verified });
      expect(rows("user")[0]?.emailVerified).toBe(false);
    },
  );
  it("rejects a changed provider email that collides with another account", async () => {
    setup();
    await signIn();
    cookies = "";
    await request("/sign-up/email", {
      email: "local@example.test",
      password: "test-password-123",
      name: "Local",
    });
    cookies = "";
    const response = await signIn({
      sub: "subject-1",
      email: "local@example.test",
      email_verified: true,
    });
    expect(response.headers.get("location")).toContain("error=account_not_linked");
    expect(rows("account")).toHaveLength(2);
  });
  it.each([true, false, undefined])(
    "refuses email collisions without any link (verified=%s)",
    async (verified) => {
      setup();
      const local = await request("/sign-up/email", {
        email: "sso@example.test",
        password: "test-password-123",
        name: "Local",
      });
      expect(local.status).toBe(200);
      cookies = "";
      const response = await signIn({
        sub: "different-subject",
        email: "sso@example.test",
        email_verified: verified,
      });
      expect(response.headers.get("location")).toContain("error=account_not_linked");
      expect(rows("user")).toHaveLength(1);
      expect(rows("account")).toHaveLength(1);
      expect(rows("account")[0]?.providerId).toBe("credential");
    },
  );
  it("does not reuse identities after changing the configured issuer", async () => {
    setup();
    await signIn();
    auth.disposeOidcDiscovery();
    cookies = "";
    activeIssuer = "https://other-identity.example.test";
    setup({
      oidc: {
        issuer: activeIssuer,
        clientId: "test-client",
        clientSecret: "fake-secret",
        name: "SSO",
        scopes: [],
        allowSignupBypass: false,
      },
    });
    expect((await signIn()).headers.get("location")).toContain("error=account_not_linked");
    expect(rows("user")).toHaveLength(1);
    expect(rows("account")).toHaveLength(1);
  });
  it("links only through an authenticated link flow", async () => {
    setup();
    expect(
      (await request("/link-social", { provider: "oidc", callbackURL: `${origin}/app` })).status,
    ).toBe(401);
    await request("/sign-up/email", {
      email: "sso@example.test",
      password: "test-password-123",
      name: "Local",
    });
    const response = await request(await start(undefined, true));
    expect(response.headers.get("location")).toBe(`${origin}/app`);
    expect(rows("account")).toHaveLength(2);
    expect(new Set(rows("account").map((account) => account.userId)).size).toBe(1);
  });
  it("offers linking after issuer replacement, retains old links, and preserves linking safety", async () => {
    setup();
    await request("/sign-up/email", {
      email: "sso@example.test",
      password: "test-password-123",
      name: "Local",
    });
    await request(await start(undefined, true));
    expect(await (await request("/account-security")).json()).toMatchObject({ ssoLinked: true });
    const oldAccountId = rows("account").find(
      (account) => account.providerId === "oidc",
    )!.accountId;
    auth.disposeOidcDiscovery();
    activeIssuer = "https://replacement.example.test";
    setup({
      oidc: {
        issuer: activeIssuer,
        clientId: "test-client",
        clientSecret: "test-client-secret",
        name: "Replacement",
        scopes: ["openid"],
        allowSignupBypass: false,
      },
    });
    expect(await (await request("/account-security")).json()).toMatchObject({ ssoLinked: false });
    const rejected = await request(
      await start({ sub: "subject-1", email: "sso@example.test", email_verified: false }, true),
    );
    expect(rejected.headers.get("location")).toContain("error=unable_to_link_account");
    expect(await (await request("/account-security")).json()).toMatchObject({ ssoLinked: false });
    const mismatch = await request(
      await start(
        { sub: "subject-1", email: "different@example.test", email_verified: true },
        true,
      ),
    );
    expect(mismatch.headers.get("location")).toContain("error=");
    const linked = await request(await start(undefined, true));
    expect(linked.headers.get("location")).toBe(`${origin}/app`);
    expect(await (await request("/account-security")).json()).toMatchObject({ ssoLinked: true });
    expect(rows("account").filter((account) => account.providerId === "oidc")).toHaveLength(2);
    expect(rows("account").some((account) => account.accountId === oldAccountId)).toBe(true);
    expect(new Set(rows("account").map((account) => account.userId)).size).toBe(1);
  });
  it.each([false, undefined])("refuses unverified explicit linking (%s)", async (verified) => {
    setup();
    await request("/sign-up/email", {
      email: "sso@example.test",
      password: "test-password-123",
      name: "Local",
    });
    const response = await request(
      await start({ sub: "subject-1", email: "sso@example.test", email_verified: verified }, true),
    );
    expect(response.headers.get("location")).toContain("error=unable_to_link_account");
    expect(rows("account")).toHaveLength(1);
  });
  it("hands the native browser callback to Expo with a valid bearer session", async () => {
    setup();
    const callback = await start(undefined, false, "rakazo://sign-in");
    const authorize = `${issuer}/authorize?state=${new URL(`${origin}${callback}`).searchParams.get("state")}`;
    const proxy = await request(
      `/expo-authorization-proxy?${new URLSearchParams({ authorizationURL: authorize })}`,
    );
    expect(proxy.headers.get("location")).toBe(authorize);
    const returned = await request(callback);
    const destination = new URL(returned.headers.get("location")!);
    expect(destination.protocol).toBe("rakazo:");
    const signed = destination.searchParams
      .get("cookie")!
      .match(/(?:__Secure-)?better-auth\.session_token=([^;]+)/)![1]!;
    cookies = "";
    const session = await request("/get-session", undefined, decodeURIComponent(signed));
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { email: "sso@example.test" } });
  });
  it("enforces the allowlist before inserting a user", async () => {
    setup({ signupAllowlist: "allowed@example.test" });
    expect((await signIn()).headers.get("location")).toContain("error=EMAIL_NOT_ALLOWED");
    expect(rows("user")).toHaveLength(0);
    expect(rows("account")).toHaveLength(0);
  });
  it("admits allowlisted verified identities", async () => {
    setup({ signupAllowlist: "sso@example.test" });
    expect((await signIn()).headers.get("location")).toBe(`${origin}/app`);
  });
  it("never upgrades an unverified allowlisted identity", async () => {
    setup({ signupAllowlist: "sso@example.test" });
    expect(
      (
        await signIn({ sub: "subject-1", email: "sso@example.test", email_verified: false })
      ).headers.get("location"),
    ).toContain("error=EMAIL_VERIFICATION_REQUIRED");
    expect(rows("user")).toHaveLength(0);
  });
  it("bypasses the allowlist only with opt-in", async () => {
    setup({
      signupAllowlist: "allowed@example.test",
      oidc: {
        issuer,
        clientId: "test-client",
        clientSecret: "fake-secret",
        name: "SSO",
        scopes: [],
        allowSignupBypass: true,
      },
    });
    expect((await signIn()).headers.get("location")).toBe(`${origin}/app`);
  });
  it.each([false, true])("closed registration stays closed with bypass=%s", async (bypass) => {
    setup({
      signupsEnabled: "false",
      oidc: {
        issuer,
        clientId: "test-client",
        clientSecret: "fake-secret",
        name: "SSO",
        scopes: [],
        allowSignupBypass: bypass,
      },
    });
    expect((await signIn()).headers.get("location")).toContain("error=REGISTRATION_CLOSED");
    expect(rows("user")).toHaveLength(0);
  });
  it("rejects state replay", async () => {
    setup();
    const callback = await start();
    expect((await request(callback)).headers.get("location")).toBe(`${origin}/app`);
    expect((await request(callback)).headers.get("location")).toContain("error=");
    expect(rows("session")).toHaveLength(1);
  });
  it("rejects a code issued to a different PKCE challenge", async () => {
    setup();
    const callback = await start();
    const value = codes.get("code-1")!;
    value.challenge = "wrong-challenge";
    expect((await request(callback)).headers.get("location")).toContain("error=invalid_code");
    expect(rows("user")).toHaveLength(0);
  });
  it("rejects a token with an invalid nonce", async () => {
    setup();
    const callback = await start();
    codes.get("code-1")!.nonce = "wrong-nonce";
    expect((await request(callback)).headers.get("location")).toContain(
      "error=unable_to_get_user_info",
    );
    expect(rows("user")).toHaveLength(0);
  });
  it("rejects a token with an invalid signature", async () => {
    setup();
    corruptSignature = true;
    expect((await signIn()).headers.get("location")).toContain("error=unable_to_get_user_info");
    expect(rows("user")).toHaveLength(0);
  });
  it("requires an ID token rather than downgrading to plain OAuth", async () => {
    setup();
    omitIdToken = true;
    expect((await signIn()).headers.get("location")).toContain("error=unable_to_get_user_info");
    expect(rows("user")).toHaveLength(0);
  });
  it("boots SSO-only while discovery is down and recovers without restart", async () => {
    vi.useFakeTimers();
    discoveryDown = true;
    setup({ passwordAuth: false });
    expect(
      (await request("/sign-in/social", { provider: "oidc", callbackURL: `${origin}/app` })).status,
    ).toBe(503);
    expect(auth.ssoAvailability()).toBe("unavailable");
    discoveryDown = false;
    await vi.advanceTimersByTimeAsync(1_001);
    expect((await signIn()).headers.get("location")).toBe(`${origin}/app`);
    expect(auth.ssoAvailability()).toBe("available");
  });
  it("rejects password auth when disabled", async () => {
    setup({ passwordAuth: false });
    for (const path of [
      "/sign-in/email",
      "/sign-up/email",
      "/request-password-reset",
      "/set-password",
    ]) {
      expect(
        (await request(path, { email: "local@example.test", password: "test-password-123" }))
          .status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(rows("user")).toHaveLength(0);
  });
  it("refuses password-off without an alternative", () => {
    expect(() => setup({ passwordAuth: false, oidc: undefined })).toThrow(/requires OIDC/);
  });
});

describe("SSO-only account deletion", () => {
  it("allows a fresh provider sign-in and removes the account", async () => {
    setup();
    await signIn();
    expect((await request("/delete-user", {})).status).toBe(200);
    expect(rows("user")).toHaveLength(0);
  });
  it("refuses a stale session, then accepts fresh reauthentication", async () => {
    setup();
    await signIn();
    expireOidcProofs();
    expect((await request("/delete-user", {})).status).toBe(403);
    await signIn();
    expect((await request("/delete-user", {})).status).toBe(200);
    expect(rows("user")).toHaveLength(0);
  });
  it("accepts an emailed deletion code from a stale bearer session", async () => {
    setup();
    await signIn();
    const sessionToken = String(rows("session")[0]!.token);
    expireOidcProofs();
    cookies = "";
    expect((await request("/delete-user", { token: "wrong-code" }, sessionToken)).status).not.toBe(
      200,
    );
    expect((await request("/request-account-deletion", {}, sessionToken)).status).toBe(200);
    const code = sentCodes.at(-1)!.match(/\b[a-f0-9]{32}\b/)![0];
    const deleted = await request("/delete-user", { token: code }, sessionToken);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(rows("user")).toHaveLength(0);
  });
  it("binds provider reauthentication to the signed-in account", async () => {
    setup();
    await signIn();
    const rejected = await request(
      await start(
        { sub: "other-subject", email: "other@example.test", email_verified: true },
        false,
        `${origin}/app`,
        true,
      ),
    );
    expect(rejected.headers.get("location")).toContain("error=REAUTHENTICATION_REQUIRED");
    expect(rows("user")).toHaveLength(1);
    expect(rows("session")).toHaveLength(1);
    const confirmed = await request(await start(undefined, false, `${origin}/app`, true));
    expect(confirmed.headers.get("location")).toBe(`${origin}/app`);
    expect((await request("/delete-user", {})).status).toBe(200);
  });
  it("refuses newly minted sessions that did not authenticate with OIDC", async () => {
    setup();
    await signIn();
    // A valid server-side session alone must not manufacture provider proof.
    state.db.session!.push({
      ...rows("session")[0],
      id: "unproven-session",
      token: "unproven-token",
      createdAt: new Date(),
    });
    cookies = "";
    expect((await request("/delete-user", {}, "unproven-token")).status).toBe(403);
    expect(rows("user")).toHaveLength(1);
  });
  it("rejects expired and wrong-account deletion codes", async () => {
    setup();
    await signIn();
    await request("/request-account-deletion", {});
    const code = sentCodes.at(-1)!.match(/\b[a-f0-9]{32}\b/)![0];
    const verification = rows("verification").find((value) =>
      String(value.identifier).includes(code),
    )!;
    verification.expiresAt = new Date(0);
    expect((await request("/delete-user", { token: code })).status).not.toBe(200);
    await request("/request-account-deletion", {});
    const otherCode = sentCodes.at(-1)!.match(/\b[a-f0-9]{32}\b/)![0];
    cookies = "";
    await signIn({ sub: "subject-2", email: "other@example.test", email_verified: true });
    expect((await request("/delete-user", { token: otherCode })).status).not.toBe(200);
    expect(rows("user")).toHaveLength(2);
  });
  it.each([true, false])(
    "keeps password deletion for credential accounts (password auth: %s)",
    async (passwordAuth) => {
      setup();
      await request("/sign-up/email", {
        email: "local@example.test",
        password: "test-password-123",
        name: "Local",
      });
      setup({ passwordAuth });
      expect(await (await request("/account-security")).json()).toMatchObject({
        hasPassword: true,
        passwordChangeEnabled: passwordAuth,
      });
      if (!passwordAuth) {
        expect(
          (
            await request("/change-password", {
              currentPassword: "test-password-123",
              newPassword: "new-password-123",
            })
          ).status,
        ).toBe(403);
      }
      expect((await request("/request-account-deletion", {})).status).toBe(400);
      expect((await request("/delete-user", {})).status).toBe(400);
      expect((await request("/delete-user", { password: "wrong-password" })).status).toBe(400);
      expect((await request("/delete-user", { password: "test-password-123" })).status).toBe(200);
    },
  );
});

it("counts only stored OIDC subjects bound to the current issuer", () => {
  const account = {
    providerId: "oidc",
    accountId: oidcAccountSubject(issuer, "subject-1"),
    idToken: jwt({ sub: "subject-1" }),
  };
  expect(isCurrentOidcAccount(account, issuer)).toBe(true);
  expect(isCurrentOidcAccount(account, undefined)).toBe(false);
  expect(isCurrentOidcAccount(account, "https://replacement.example.test")).toBe(false);
  expect(isCurrentOidcAccount({ ...account, providerId: "credential" }, issuer)).toBe(false);
  expect(isCurrentOidcAccount({ ...account, accountId: "unbound" }, issuer)).toBe(false);
  expect(isCurrentOidcAccount({ ...account, idToken: null }, issuer)).toBe(false);
  expect(isCurrentOidcAccount({ ...account, idToken: "malformed" }, issuer)).toBe(false);
});
