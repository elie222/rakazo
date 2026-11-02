import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import type * as Db from "@rakazo/db";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Auth, AuthEnv } from "./index.js";
import { createAuth } from "./index.js";
import { isCurrentOidcAccount, oidcAccountSubject } from "./oidc.js";
import { encryptStoredOAuthTokens, openIdToken, sealIdToken } from "./token-storage.js";

const state = vi.hoisted(() => ({ db: {} as Record<string, Record<string, unknown>[]> }));
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: () => memoryAdapter(state.db) }));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  bootstrapUserSpace: vi.fn(),
}));

const issuer = "https://identity.example.test";
const origin = "https://rakazo.example.test";
const secret = "offline-test-secret-with-at-least-32-characters";
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
let replayedIdToken: string | undefined;
let userInfoClaims: Record<string, unknown>;
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

function setup(options: Partial<AuthEnv> = {}, hasMembership = true) {
  const prisma: Record<string, unknown> = {
    deploymentSettings: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    spaceMember: {
      findFirst: vi.fn(async () => (hasMembership ? { id: "existing-space" } : null)),
    },
    member: { findMany: vi.fn(async () => []) },
    messagingIdentity: { deleteMany: vi.fn(async () => ({})) },
    passkey: { deleteMany: vi.fn(async () => ({})) },
    organization: { deleteMany: vi.fn(async () => ({})) },
  };
  prisma.$transaction = vi.fn(async (operations: (tx: unknown) => Promise<unknown>) =>
    operations(prisma),
  );
  auth = createAuth(prisma as never, {
    secret,
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

/** Signs a stored session token the way the session cookie and `set-auth-token` do. */
function signedBearer(token: string) {
  if (token.includes(".")) return token;
  return `${token}.${createHmac("sha256", secret).update(token).digest("base64")}`;
}

async function request(
  path: string,
  body?: unknown,
  bearer?: string,
  overrides: Record<string, string | null> = {},
) {
  const headers = new Headers({
    origin,
    "content-type": "application/json",
    ...(cookies ? { cookie: cookies } : {}),
    ...(bearer ? { authorization: `Bearer ${signedBearer(bearer)}` } : {}),
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  // Better Auth disables origin checks in tests; exercise production CSRF behavior here.
  const context = await auth.$context;
  context.skipOriginCheck = false;
  context.skipCSRFCheck = false;
  const response = await auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
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
  additionalData: Record<string, unknown> = {},
) {
  const response = await request(link ? "/link-social" : "/sign-in/social", {
    provider: "oidc",
    callbackURL,
    errorCallbackURL: `${origin}/sign-in`,
    disableRedirect: true,
    additionalData: { ...additionalData, ...(reauthenticate ? { reauthenticate: true } : {}) },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const url = new URL(((await response.json()) as { url: string }).url);
  const code = `code-${++sequence}`;
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("prompt")).toBe(reauthenticate ? "login" : null);
  expect(url.searchParams.get("max_age")).toBe(reauthenticate ? "0" : null);
  codes.set(code, {
    challenge: url.searchParams.get("code_challenge")!,
    nonce: url.searchParams.get("nonce")!,
    claims: {
      ...(reauthenticate ? { auth_time: Math.floor(Date.now() / 1_000) } : {}),
      ...claims,
    },
  });
  return `/callback/oidc?state=${url.searchParams.get("state")}&code=${code}`;
}
async function signIn(claims?: Record<string, unknown>) {
  return request(await start(claims));
}
const rows = (model: string) => state.db[model] ?? [];
const hashedIdentifier = (identifier: string) =>
  createHash("sha256").update(identifier).digest("base64url");

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
  replayedIdToken = undefined;
  userInfoClaims = { sub: "subject-1", email: "sso@example.test", email_verified: true };
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
      if (url.pathname === "/userinfo") return json(userInfoClaims);
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
          ...(omitIdToken
            ? {}
            : { id_token: replayedIdToken ?? jwt({ ...value.claims, nonce: value.nonce }) }),
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
  it("stores provider tokens encrypted and still reads them", async () => {
    setup();
    await signIn();
    const stored = () => rows("account").find((account) => account.providerId === "oidc")!;
    const first = { ...stored() };
    expect(first.accessToken).toEqual(expect.any(String));
    expect(first.accessToken).not.toBe("fake-access-token");
    expect(String(first.idToken)).not.toContain(".");
    expect(await openIdToken(secret, String(first.idToken))).toMatch(/^ey/);
    expect(await (await request("/account-security")).json()).toMatchObject({ ssoLinked: true });
    const tokens = await request("/get-access-token", { accountId: String(first.id) });
    expect(tokens.status, await tokens.clone().text()).toBe(200);
    expect(await tokens.json()).toMatchObject({
      accessToken: "fake-access-token",
      idToken: await openIdToken(secret, String(first.idToken)),
    });
    cookies = "";
    const again = await signIn();
    expect(again.headers.get("location")).toBe(`${origin}/app`);
    expect(String(stored().idToken)).not.toContain(".");
    expect(await openIdToken(secret, String(stored().idToken))).toMatch(/^ey/);
    expect(await (await request("/account-security")).json()).toMatchObject({ ssoLinked: true });
  });
  it("keeps accounts stored before token encryption working, then encrypts them", async () => {
    setup();
    await signIn();
    const account = rows("account").find((row) => row.providerId === "oidc")!;
    const idToken = jwt({ sub: "subject-1", email: "sso@example.test" });
    Object.assign(account, {
      accessToken: "legacy-access-token",
      refreshToken: "legacy-refresh-token",
      idToken,
    });
    expect(await (await request("/account-security")).json()).toMatchObject({ ssoLinked: true });
    const prisma = {
      account: {
        findMany: vi.fn(async () => rows("account").map((row) => ({ ...row }))),
        updateMany: vi.fn(
          async ({ where, data }: { where: Record<string, unknown>; data: object }) => {
            const row = rows("account").find((item) =>
              Object.entries(where).every(([key, value]) => (item[key] ?? null) === value),
            );
            if (row) Object.assign(row, data);
            return { count: row ? 1 : 0 };
          },
        ),
      },
    };
    expect(await encryptStoredOAuthTokens(prisma as never, secret)).toBe(1);
    expect(account.accessToken).not.toBe("legacy-access-token");
    expect(account.refreshToken).not.toBe("legacy-refresh-token");
    expect(await openIdToken(secret, String(account.idToken))).toBe(idToken);
    expect(await (await request("/account-security")).json()).toMatchObject({ ssoLinked: true });
    expect(await encryptStoredOAuthTokens(prisma as never, secret)).toBe(0);

    // A sign-in that refreshes the row after the upgrade read it must win.
    account.accessToken = "legacy-access-token";
    prisma.account.findMany.mockImplementationOnce(async () => {
      const read = rows("account").map((row) => ({ ...row }));
      account.accessToken = "refreshed-access-token";
      return read;
    });
    expect(await encryptStoredOAuthTokens(prisma as never, secret)).toBe(0);
    expect(account.accessToken).toBe("refreshed-access-token");
  });
  it("stores deletion codes hashed and accepts one stored before hashing", async () => {
    setup();
    await signIn();
    await request("/request-account-deletion", {});
    const code = sentCodes.at(-1)!.match(/\b[a-f0-9]{32}\b/)![0];
    expect(rows("verification").some((row) => String(row.identifier).includes(code))).toBe(false);
    rows("verification").push({
      id: "legacy-deletion-code",
      identifier: "delete-account-legacy-code",
      value: rows("user")[0]!.id,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const deleted = await request("/delete-user", { token: "legacy-code" });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(rows("user")).toHaveLength(0);
  });
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
  it.each([
    "https://attacker.example.test/authorize",
    `${issuer}/elsewhere`,
    "https://identity.example.test.attacker.example.test/authorize",
  ])(
    "only lets the native proxy redirect to the SSO authorization endpoint (%s)",
    async (target) => {
      setup();
      const response = await request(
        `/expo-authorization-proxy?${new URLSearchParams({ authorizationURL: `${target}?state=planted` })}`,
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(cookies).not.toContain("state=");
    },
  );
  it("closes the native proxy without SSO", async () => {
    setup({ oidc: undefined });
    const response = await request(
      `/expo-authorization-proxy?${new URLSearchParams({ authorizationURL: "https://attacker.example.test/x?state=planted" })}`,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
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
  it("redirects an unprovisioned identity when registration closes", async () => {
    setup();
    expect((await signIn()).headers.get("location")).toBe(`${origin}/app`);
    auth.disposeOidcDiscovery();
    setup({ signupsEnabled: "false" }, false);
    const response = await signIn();
    expect(response.headers.get("location")).toContain(
      `${origin}/sign-in?error=REGISTRATION_CLOSED`,
    );
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
  it.each([false, true])(
    "binds UserInfo to the verified ID-token subject (reauthentication: %s)",
    async (reauthenticate) => {
      setup();
      await signIn();
      // A valid token for another subject must not become this user's account
      // through a UserInfo response naming their already-linked subject.
      const callback = await start(
        { sub: "other-subject" },
        false,
        `${origin}/app`,
        reauthenticate,
      );
      const before = structuredClone({
        users: rows("user"),
        accounts: rows("account"),
        sessions: rows("session"),
      });
      expect((await request(callback)).headers.get("location")).toContain("error=");
      expect({ users: rows("user"), accounts: rows("account"), sessions: rows("session") }).toEqual(
        before,
      );
      expect(await (await request("/account-security")).json()).toMatchObject({
        freshOidcAuth: false,
      });
    },
  );

  it.each([false, true])(
    "accepts matching UserInfo subjects (reauthentication: %s)",
    async (reauthenticate) => {
      setup();
      await signIn();
      const callback = await start({ sub: "subject-1" }, false, `${origin}/app`, reauthenticate);
      expect((await request(callback)).headers.get("location")).toBe(`${origin}/app`);
      expect(await (await request("/account-security")).json()).toMatchObject({
        freshOidcAuth: reauthenticate,
      });
    },
  );

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
      "/email-otp/send-verification-otp",
      "/sign-in/email-otp",
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
  it.each([
    ["missing", undefined],
    ["stale", -3_600],
    ["before-request-window", -61],
    ["outside-freshness-window", -300],
    ["future", 120],
    ["string", "0"],
    ["null", null],
  ])("rejects reauthentication with a %s signed auth_time", async (_name, offset) => {
    setup();
    await signIn();
    const authTime = typeof offset === "number" ? Math.floor(Date.now() / 1_000) + offset : offset;
    const response = await request(
      await start(
        {
          sub: "subject-1",
          email: "sso@example.test",
          email_verified: true,
          auth_time: authTime,
        },
        false,
        `${origin}/app`,
        true,
      ),
    );
    expect(response.headers.get("location")).toContain("error=");
    expect(await (await request("/account-security")).json()).toMatchObject({
      freshOidcAuth: false,
    });
    expect((await request("/delete-user", {})).status).toBe(403);
  });

  it("accepts a signed fractional auth_time within the request window", async () => {
    setup();
    await signIn();
    const response = await request(
      await start(
        {
          sub: "subject-1",
          email: "sso@example.test",
          email_verified: true,
          auth_time: Date.now() / 1_000 - 0.5,
        },
        false,
        `${origin}/app`,
        true,
      ),
    );
    expect(response.headers.get("location")).toBe(`${origin}/app`);
    expect(await (await request("/account-security")).json()).toMatchObject({
      freshOidcAuth: true,
    });
  });

  it("rejects provider authentication that ages out before the callback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setup();
    await signIn();
    const callback = await start(undefined, false, `${origin}/app`, true);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const response = await request(callback);
    expect(response.headers.get("location")).toContain("error=");
    expect((await request("/delete-user", {})).status).toBe(403);
  });

  it("caps proof expiry at provider authentication even when the callback is delayed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setup();
    await signIn();
    const authenticatedAt = Math.floor(Date.now() / 1_000) * 1_000;
    const callback = await start(undefined, false, `${origin}/app`, true);
    vi.setSystemTime(authenticatedAt + 4 * 60_000);
    expect((await request(callback)).headers.get("location")).toBe(`${origin}/app`);
    expect(await (await request("/account-security")).json()).toMatchObject({
      freshOidcAuth: true,
    });
    const proof = rows("verification").find((row) =>
      String(row.identifier).startsWith("oidc-reauth-"),
    )!;
    expect(proof.expiresAt).toEqual(new Date(authenticatedAt + 5 * 60_000));
    vi.setSystemTime(authenticatedAt + 5 * 60_000);
    expect((await request("/delete-user", {})).status).toBe(403);
  });

  it.each(["revoked", "expired"])(
    "rejects a callback after its initiating session is %s",
    async (kind) => {
      setup();
      await signIn();
      const callback = await start(undefined, false, `${origin}/app`, true);
      if (kind === "revoked") state.db.session = [];
      else rows("session")[0]!.expiresAt = new Date(0);
      const returned = await request(callback);
      expect(returned.headers.get("location")).toContain("error=");
      expect(rows("session")).toHaveLength(kind === "revoked" ? 0 : 1);
      expect(
        rows("verification").some((row) => String(row.identifier).startsWith("oidc-reauth-")),
      ).toBe(false);
    },
  );

  it("requires an existing link before starting reauthentication", async () => {
    setup();
    await request("/sign-up/email", {
      email: "local@example.test",
      password: "test-password-123",
      name: "Local",
    });
    expect(
      (
        await request("/sign-in/social", {
          provider: "oidc",
          additionalData: { reauthenticate: true },
        })
      ).status,
    ).toBe(403);
  });

  it.each(["same-email", "other-user", "unlinked", "reassigned"])(
    "rejects a different or changed linked identity (%s) before any mutation",
    async (kind) => {
      setup();
      await signIn();
      const originalCookies = cookies;
      if (kind === "other-user") {
        cookies = "";
        await signIn({ sub: "subject-2", email: "other@example.test", email_verified: true });
        cookies = originalCookies;
      }
      const callback = await start(
        kind === "same-email" || kind === "other-user"
          ? {
              sub: "subject-2",
              email: kind === "same-email" ? "sso@example.test" : "other@example.test",
              email_verified: true,
            }
          : undefined,
        false,
        `${origin}/app`,
        true,
      );
      if (kind === "unlinked") state.db.account = [];
      if (kind === "reassigned") rows("account")[0]!.userId = "different-user";
      const before = structuredClone({
        users: rows("user"),
        accounts: rows("account"),
        sessions: rows("session"),
      });
      expect((await request(callback)).headers.get("location")).toContain("error=");
      expect({ users: rows("user"), accounts: rows("account"), sessions: rows("session") }).toEqual(
        before,
      );
      expect(await (await request("/account-security")).json()).toMatchObject({
        freshOidcAuth: false,
      });
    },
  );

  it("rejects a signed reauthentication token from a different issuer", async () => {
    setup();
    await signIn();
    const callback = await start(
      {
        sub: "subject-1",
        iss: "https://other.example.test",
        email: "sso@example.test",
        email_verified: true,
      },
      false,
      `${origin}/app`,
      true,
    );
    expect((await request(callback)).headers.get("location")).toContain("error=");
    expect(rows("session")).toHaveLength(1);
    expect(await (await request("/account-security")).json()).toMatchObject({
      freshOidcAuth: false,
    });
  });

  it("consumes reauthentication callbacks atomically before exchanging the code", async () => {
    setup();
    await signIn();
    const callback = await start(undefined, false, `${origin}/app`, true);
    const exchanges = () =>
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/token")).length;
    const before = exchanges();
    const results = await Promise.all([request(callback), request(callback)]);
    expect(
      results.filter((response) => response.headers.get("location") === `${origin}/app`),
    ).toHaveLength(1);
    expect(exchanges() - before).toBe(1);
    expect(rows("session")).toHaveLength(2);
    const savedCookies = cookies;
    expect((await request(callback)).headers.get("location")).toContain("error=");
    cookies = savedCookies;
    expect(exchanges() - before).toBe(1);
  });

  it.each([false, true])(
    "cannot swap login and reauthentication codes (reauthentication: %s)",
    async (reauthenticate) => {
      setup();
      await signIn();
      const first = await start(undefined, false, `${origin}/app`, !reauthenticate);
      const second = await start(undefined, false, `${origin}/app`, reauthenticate);
      expect(codes.get("code-2")!.nonce).not.toBe(codes.get("code-3")!.nonce);
      expect(new URL(`${origin}${first}`).searchParams.get("state")).not.toBe(
        new URL(`${origin}${second}`).searchParams.get("state"),
      );
      const swapped = second.replace("code=code-3", "code=code-2");
      expect((await request(swapped)).headers.get("location")).toContain("error=");
      expect(rows("session")).toHaveLength(1);
      expect(await (await request("/account-security")).json()).toMatchObject({
        freshOidcAuth: false,
      });
    },
  );

  it("rejects replay of an earlier signed ID token under a fresh reauthentication state", async () => {
    setup();
    await signIn();
    await start(undefined, false, `${origin}/app`, true);
    const previous = codes.get("code-2")!;
    replayedIdToken = jwt({ ...previous.claims, nonce: previous.nonce });
    const callback = await start(undefined, false, `${origin}/app`, true);
    expect((await request(callback)).headers.get("location")).toContain("error=");
    expect(rows("session")).toHaveLength(1);
    expect(await (await request("/account-security")).json()).toMatchObject({
      freshOidcAuth: false,
    });
  });

  it.each(["missing-state", "changed-state", "missing-cookie", "expired-state"])(
    "rejects reauthentication with %s",
    async (kind) => {
      setup();
      await signIn();
      let callback = await start(undefined, false, `${origin}/app`, true);
      if (kind === "missing-state") callback = callback.replace(/state=[^&]+&/, "");
      if (kind === "changed-state") callback = callback.replace(/state=[^&]+/, "state=forged");
      if (kind === "missing-cookie") cookies = "";
      if (kind === "expired-state") {
        const value = rows("verification").find((row) =>
          String(row.identifier).startsWith("auth-state:"),
        )!;
        const data = JSON.parse(String(value.value));
        data.expiresAt = 0;
        value.value = JSON.stringify(data);
      }
      expect((await request(callback)).headers.get("location")).toContain("error=");
      expect(rows("session")).toHaveLength(1);
      expect(
        rows("verification").some((row) => String(row.identifier).startsWith("oidc-reauth-")),
      ).toBe(false);
    },
  );

  it.each(["https://attacker.example.test", "null", null])(
    "blocks cookie-authenticated CSRF from origin %s",
    async (untrustedOrigin) => {
      setup();
      await signIn();
      const before = rows("verification").length;
      const headers = { origin: untrustedOrigin, "sec-fetch-site": "cross-site" };
      expect(
        (
          await request(
            "/sign-in/social",
            { provider: "oidc", additionalData: { reauthenticate: true } },
            undefined,
            headers,
          )
        ).status,
      ).toBe(403);
      expect(rows("verification")).toHaveLength(before);
      await request(await start(undefined, false, `${origin}/app`, true));
      expect((await request("/delete-user", {}, undefined, headers)).status).toBe(403);
      expect((await request("/request-account-deletion", {}, undefined, headers)).status).toBe(403);
      expect(rows("user")).toHaveLength(1);
      expect((await request("/delete-user", {})).status).toBe(200);
    },
  );

  it("does not treat a query-string deletion token as verified POST proof", async () => {
    setup();
    await signIn();
    expect((await request("/delete-user?token=unverified", {})).status).toBe(403);
    expect(rows("user")).toHaveLength(1);
    await request("/request-account-deletion", {});
    const code = sentCodes.at(-1)!.match(/\b[a-f0-9]{32}\b/)![0];
    expect((await request(`/delete-user?token=${code}`, {})).status).toBe(403);
    expect(rows("user")).toHaveLength(1);
    expect((await request("/delete-user", { token: code })).status).toBe(200);
    expect((await request("/delete-user", { token: code })).status).not.toBe(200);
  });

  it.each(["nonce", "signature", "audience", "missing-subject"])(
    "rejects invalid signed reauthentication input (%s)",
    async (kind) => {
      setup();
      await signIn();
      const callback = await start(undefined, false, `${origin}/app`, true);
      const value = codes.get("code-2")!;
      if (kind === "nonce") value.nonce = "wrong-nonce";
      if (kind === "signature") corruptSignature = true;
      if (kind === "audience") value.claims.aud = "other-client";
      if (kind === "missing-subject") delete value.claims.sub;
      expect((await request(callback)).headers.get("location")).toContain("error=");
      expect(rows("session")).toHaveLength(1);
      expect(await (await request("/account-security")).json()).toMatchObject({
        freshOidcAuth: false,
      });
    },
  );

  it("never deletes through a GET callback, even with a valid emailed code", async () => {
    setup();
    await signIn();
    await request("/request-account-deletion", {});
    const code = sentCodes.at(-1)!.match(/\b[a-f0-9]{32}\b/)![0];
    expect(
      (await request(`/delete-user/callback?token=${code}`, undefined, undefined, { origin: null }))
        .status,
    ).toBe(403);
    expect(rows("user")).toHaveLength(1);
    expect((await request("/delete-user", { token: code })).status).toBe(200);
  });

  it("supports reauthentication started by native bearer without a browser session cookie", async () => {
    setup();
    await signIn();
    const token = String(rows("session")[0]!.token);
    cookies = "";
    const response = await request(
      "/sign-in/social",
      {
        provider: "oidc",
        callbackURL: "rakazo://sign-in",
        additionalData: { reauthenticate: true },
      },
      token,
      { origin: null },
    );
    expect(response.status).toBe(200);
    const url = new URL(((await response.json()) as { url: string }).url);
    const nonce = url.searchParams.get("nonce")!;
    codes.set("native-reauth", {
      nonce,
      challenge: url.searchParams.get("code_challenge")!,
      claims: {
        sub: "subject-1",
        email: "sso@example.test",
        email_verified: true,
        auth_time: Math.floor(Date.now() / 1000),
      },
    });
    const authorize = `${issuer}/authorize?state=${url.searchParams.get("state")}`;
    await request(
      `/expo-authorization-proxy?${new URLSearchParams({ authorizationURL: authorize })}`,
    );
    const returned = await request(
      `/callback/oidc?state=${url.searchParams.get("state")}&code=native-reauth`,
    );
    const destination = new URL(returned.headers.get("location")!);
    expect(destination.protocol).toBe("rakazo:");
    const signed = destination.searchParams
      .get("cookie")!
      .match(/(?:__Secure-)?better-auth\.session_token=([^;]+)/)![1]!;
    cookies = "";
    const bearer = decodeURIComponent(signed);
    expect(
      await (await request("/account-security", undefined, bearer, { origin: null })).json(),
    ).toMatchObject({ freshOidcAuth: true });
    expect((await request("/delete-user", {}, bearer, { origin: null })).status).toBe(200);
  });

  it("requires an authenticated session before starting reauthentication", async () => {
    setup();
    const response = await request("/sign-in/social", {
      provider: "oidc",
      callbackURL: `${origin}/app`,
      additionalData: { reauthenticate: true },
    });
    expect(response.status).toBe(401);
    expect(rows("session")).toHaveLength(0);
  });

  it("does not trust client-supplied reauthentication context", async () => {
    setup();
    await signIn();
    const userId = rows("user")[0]!.id;
    await request(
      await start(undefined, false, `${origin}/app`, false, {
        reauthUserId: userId,
        reauthStartedAt: Math.floor(Date.now() / 1_000),
        reauthExpiresAt: Date.now() + 300_000,
        serverContext: {
          reauthUserId: userId,
          reauthExpiresAt: Date.now() + 300_000,
          reauthAccountIds: [rows("account")[0]!.accountId],
          reauthSessionToken: rows("session")[0]!.token,
        },
      }),
    );
    expect(await (await request("/account-security")).json()).toMatchObject({
      freshOidcAuth: false,
    });
    expect((await request("/delete-user", {})).status).toBe(403);
  });

  it("does not let client authorization parameters weaken reauthentication", async () => {
    setup();
    await signIn();
    const response = await request("/sign-in/social", {
      provider: "oidc",
      callbackURL: `${origin}/app`,
      disableRedirect: true,
      additionalData: { reauthenticate: true },
      additionalParams: { prompt: "none", max_age: "86400" },
    });
    expect(response.status).toBe(200);
    const url = new URL(((await response.json()) as { url: string }).url);
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("max_age")).toBe("0");
  });

  it.each(["state", "nonce", "code_challenge", "redirect_uri"])(
    "rejects client overrides of protocol parameter %s",
    async (parameter) => {
      setup();
      await signIn();
      const response = await request("/sign-in/social", {
        provider: "oidc",
        additionalData: { reauthenticate: true },
        additionalParams: { [parameter]: "attacker-controlled" },
      });
      expect(response.status).toBe(400);
      expect(rows("session")).toHaveLength(1);
    },
  );

  it("keeps ordinary and explicit sign-in policy separate in concurrent requests", async () => {
    setup();
    await signIn();
    const urls = await Promise.all(
      [false, true].map(async (reauthenticate) => {
        const response = await request("/sign-in/social", {
          provider: "oidc",
          callbackURL: `${origin}/app`,
          disableRedirect: true,
          additionalData: { reauthenticate },
        });
        expect(response.status).toBe(200);
        return new URL(((await response.json()) as { url: string }).url);
      }),
    );
    expect(urls[0]!.searchParams.get("prompt")).toBeNull();
    expect(urls[0]!.searchParams.get("max_age")).toBeNull();
    expect(urls[1]!.searchParams.get("prompt")).toBe("login");
    expect(urls[1]!.searchParams.get("max_age")).toBe("0");
  });

  it("does not transfer a previous reauthentication proof to a normal sign-in", async () => {
    setup();
    await signIn();
    await request(await start(undefined, false, `${origin}/app`, true));
    expect(await (await request("/account-security")).json()).toMatchObject({
      freshOidcAuth: true,
    });
    await signIn();
    expect(await (await request("/account-security")).json()).toMatchObject({
      freshOidcAuth: false,
    });
    expect((await request("/delete-user", {})).status).toBe(403);
  });

  it("requires explicit reauthentication instead of treating SSO sign-in as fresh proof", async () => {
    setup();
    await signIn({
      sub: "subject-1",
      email: "sso@example.test",
      email_verified: true,
      auth_time: Math.floor(Date.now() / 1000) - 86400,
    });
    expect(await (await request("/account-security")).json()).toMatchObject({
      freshOidcAuth: false,
    });
    expect((await request("/delete-user", {})).status).toBe(403);
    await request(await start(undefined, false, `${origin}/app`, true));
    expect(await (await request("/account-security")).json()).toMatchObject({
      freshOidcAuth: true,
    });
    expect((await request("/delete-user", {})).status).toBe(200);
    expect(rows("user")).toHaveLength(0);
  });
  it("confirms identity for the session a fresh SSO sign-in creates", async () => {
    setup();
    await signIn();
    const confirmed = (row: Record<string, unknown>) =>
      auth.hasRecentIdentityConfirmation({
        sessionId: String(row.id),
        userId: String(row.userId),
      });
    const first = rows("session").at(-1)!;
    expect(await confirmed(first)).toBe(false);
    expect((await request("/confirm-identity", {})).status).toBe(400);
    await request(await start(undefined, false, `${origin}/app`, true));
    const current = rows("session").at(-1)!;
    expect(current.id).not.toBe(first.id);
    expect(await confirmed(current)).toBe(true);
    expect(await confirmed(first)).toBe(false);
    expireOidcProofs();
    expect(await confirmed(current)).toBe(false);
  });
  it("refuses a stale session, then accepts fresh reauthentication", async () => {
    setup();
    await signIn();
    await request(await start(undefined, false, `${origin}/app`, true));
    expireOidcProofs();
    expect((await request("/delete-user", {})).status).toBe(403);
    await signIn();
    expect((await request("/delete-user", {})).status).toBe(403);
    await request(await start(undefined, false, `${origin}/app`, true));
    expect((await request("/delete-user", {})).status).toBe(200);
    expect(rows("user")).toHaveLength(0);
  });
  it("accepts an emailed deletion code from a stale bearer session", async () => {
    setup();
    await signIn();
    const sessionToken = String(rows("session")[0]!.token);
    expireOidcProofs();
    cookies = "";
    // A token copied from the session table is not a session.
    const raw = { authorization: `Bearer ${sessionToken}` };
    expect((await request("/request-account-deletion", {}, undefined, raw)).status).toBe(401);
    expect((await request("/delete-user", {}, undefined, raw)).status).toBe(401);
    const reauth = { provider: "oidc", additionalData: { reauthenticate: true } };
    expect((await request("/sign-in/social", reauth, undefined, raw)).status).toBe(401);
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
    expect(rejected.headers.get("location")).toContain("error=unable_to_get_user_info");
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
    const verification = rows("verification").find(
      (value) => value.identifier === hashedIdentifier(`delete-account-${code}`),
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

it("counts only stored OIDC subjects bound to the current issuer", async () => {
  const account = {
    providerId: "oidc",
    accountId: oidcAccountSubject(issuer, "subject-1"),
    idToken: jwt({ sub: "subject-1" }),
  };
  const sealed = { ...account, idToken: await sealIdToken(secret, account.idToken) };
  expect(await isCurrentOidcAccount(account, issuer, secret)).toBe(true);
  expect(await isCurrentOidcAccount(sealed, issuer, secret)).toBe(true);
  expect(await isCurrentOidcAccount(sealed, issuer, "another-secret-with-32-characters!")).toBe(
    false,
  );
  expect(await isCurrentOidcAccount(account, undefined, secret)).toBe(false);
  expect(await isCurrentOidcAccount(account, "https://replacement.example.test", secret)).toBe(
    false,
  );
  expect(await isCurrentOidcAccount({ ...account, providerId: "credential" }, issuer, secret)).toBe(
    false,
  );
  expect(await isCurrentOidcAccount({ ...account, accountId: "unbound" }, issuer, secret)).toBe(
    false,
  );
  expect(await isCurrentOidcAccount({ ...account, idToken: null }, issuer, secret)).toBe(false);
  expect(await isCurrentOidcAccount({ ...account, idToken: "malformed" }, issuer, secret)).toBe(
    false,
  );
});
