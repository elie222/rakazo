import type { BotSecretDestination } from "@rakazo/contracts";
import { encodeLoginSecret } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeSecretDestination,
  requestWithBotSecret,
  resolveLoginFill,
} from "./bot-secrets.js";
import { EncryptedSecretStore } from "./secrets.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };
const destination: BotSecretDestination = {
  name: "example_api",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
};
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const secret = "fake-key-with+/special=characters";
const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

async function fixture(auth = destination.auth) {
  const encrypted = await secretStore.put(
    secret,
    {
      ...scope,
      operationId: "test",
      traceId: "test",
      signal: new AbortController().signal,
    },
    "secret-1",
  );
  const row = { ...scope, ...destination, auth, ...encrypted };
  const findFirst = vi.fn(async ({ where }) =>
    Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)
      ? row
      : null,
  );
  const prisma = { botSecret: { findFirst } } as unknown as PrismaClient;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
  const registerRedactions = vi.fn();
  const input = {
    prisma,
    secretStore,
    scope,
    request: { name: destination.name, url: `${destination.origin}/v1/items` },
    signal: new AbortController().signal,
    remote: { fetch, resolveHostname: publicResolver },
    registerRedactions,
  };
  return { input, fetch, findFirst, registerRedactions };
}

describe("authenticated secret requests", () => {
  it.each([
    [{ type: "bearer" }, "Authorization", `Bearer ${secret}`],
    [{ type: "header", name: "X-Api-Key" }, "X-Api-Key", secret],
    [
      { type: "basic", username: "api-user" },
      "Authorization",
      `Basic ${Buffer.from(`api-user:${secret}`).toString("base64")}`,
    ],
  ] as const)(
    "injects %j only in backend headers and redacts response echoes",
    async (auth, header, value) => {
      const { input, fetch, registerRedactions } = await fixture(auth);
      fetch.mockImplementation(async (_url, init) => {
        expect(new Headers(init?.headers).get(header)).toBe(value);
        expect(init?.redirect).toBe("manual");
        return Response.json({
          [secret]: [
            secret,
            value,
            encodeURIComponent(secret),
            Buffer.from(secret).toString("base64"),
          ],
          items: [1, 2],
        });
      });
      const result = await requestWithBotSecret(input);
      expect(result).toMatchObject({ status: 200, body: { items: [1, 2] }, truncated: false });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(value);
      expect(JSON.stringify(result)).not.toContain(encodeURIComponent(secret));
      expect(registerRedactions).toHaveBeenCalledWith(expect.arrayContaining([secret, value]));
    },
  );

  it.each(["userId", "spaceId", "botId"] as const)(
    "denies a different %s before decrypting or sending",
    async (key) => {
      const { input, fetch } = await fixture();
      const load = vi.spyOn(secretStore, "load");
      try {
        expect(
          await requestWithBotSecret({ ...input, scope: { ...scope, [key]: "other" } }),
        ).toMatchObject({ error: expect.any(String) });
        expect(load).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        load.mockRestore();
      }
    },
  );

  it.each([
    "https://other.example.test/v1",
    "http://api.example.test/v1",
    "https://api.example.test:8443/v1",
    "https://api.example.test.evil.test/v1",
    "https://user:password@api.example.test/v1",
    "https://api.example.test/v1#fragment",
  ])("rejects destination %s", async (url) => {
    const { input, fetch } = await fixture();
    expect(
      await requestWithBotSecret({ ...input, request: { ...input.request, url } }),
    ).toMatchObject({ error: expect.any(String) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects private DNS answers without issuing a request", async () => {
    const { input, fetch } = await fixture();
    input.remote.resolveHostname = async () => [{ address: "169.254.169.254", family: 4 }];
    expect(await requestWithBotSecret(input)).toMatchObject({ error: expect.any(String) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never follows redirects, including same-origin redirects", async () => {
    const { input, fetch } = await fixture();
    fetch.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: `${destination.origin}/redirected` },
      }),
    );
    expect(await requestWithBotSecret(input)).toMatchObject({ error: expect.any(String) });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not expose exception text or response headers", async () => {
    const { input, fetch } = await fixture();
    fetch.mockRejectedValueOnce(new Error(secret));
    expect(JSON.stringify(await requestWithBotSecret(input))).not.toContain(secret);
    fetch.mockResolvedValueOnce(new Response("ok", { headers: { "X-Echo": secret } }));
    expect(await requestWithBotSecret(input)).toEqual({
      status: 200,
      body: "ok",
      truncated: false,
    });
  });

  it("redacts before truncating and bounds the response body", async () => {
    const { input, fetch } = await fixture();
    fetch.mockResolvedValueOnce(new Response("x".repeat(19_990) + secret));
    const result = await requestWithBotSecret(input);
    expect(result).toMatchObject({ truncated: true });
    expect(JSON.stringify(result)).not.toContain("fake-key");
    fetch.mockResolvedValueOnce(new Response("x".repeat(1_000_001)));
    expect(await requestWithBotSecret(input)).toMatchObject({ error: expect.any(String) });
  });

  it("cancels a stalled response body", async () => {
    const { input, fetch } = await fixture();
    const controller = new AbortController();
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const pending = requestWithBotSecret({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    expect(await pending).toMatchObject({ error: expect.any(String) });
    expect(cancel).toHaveBeenCalled();
  });

  it("delivers plain-HTTP private destination requests directly when the owner opts in", async () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const encrypted = await secretStore.put(
      secret,
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      "secret-2",
    );
    const row = {
      ...scope,
      name: "hive_api_token",
      origin: "http://192.168.2.10:8080",
      auth: { type: "bearer" as const },
      ...encrypted,
    };
    const findFirst = vi.fn(async ({ where }) =>
      Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)
        ? row
        : null,
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
    const input = {
      prisma: { botSecret: { findFirst } } as unknown as PrismaClient,
      secretStore,
      scope,
      request: { name: "hive_api_token", url: "http://192.168.2.10:8080/v1/items" },
      signal: new AbortController().signal,
      remote: {
        fetch,
        resolveHostname: async () => [{ address: "192.168.2.10", family: 4 as const }],
      },
      registerRedactions: vi.fn(),
    };
    expect(await requestWithBotSecret(input)).toEqual({
      status: 200,
      body: { ok: true },
      truncated: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit | undefined];
    expect(String(url)).toBe("http://192.168.2.10:8080/v1/items");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${secret}`);
  });

  it("refuses an opted-in private destination that resolves publicly", async () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const encrypted = await secretStore.put(
      secret,
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      "secret-3",
    );
    const row = {
      ...scope,
      name: "hive_api_token",
      origin: "http://nas.local:8080",
      auth: { type: "bearer" as const },
      ...encrypted,
    };
    const findFirst = vi.fn(async () => row);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
    const input = {
      prisma: { botSecret: { findFirst } } as unknown as PrismaClient,
      secretStore,
      scope,
      request: { name: "hive_api_token", url: "http://nas.local:8080/v1/items" },
      signal: new AbortController().signal,
      remote: {
        fetch,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      },
      registerRedactions: vi.fn(),
    };
    expect(await requestWithBotSecret(input)).toEqual({
      error: expect.stringContaining("Authenticated request failed"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("normalizeSecretDestination", () => {
  const lanDestination = {
    name: "hive_api_token",
    origin: "http://192.168.2.10:8080",
    auth: { type: "bearer" as const },
  };

  it("rejects plain-HTTP private origins by default", () => {
    expect(() => normalizeSecretDestination(lanDestination)).toThrow();
  });

  it("accepts plain-HTTP private origins when the owner opts in", () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    expect(normalizeSecretDestination(lanDestination)).toMatchObject({
      name: "hive_api_token",
      origin: "http://192.168.2.10:8080",
    });
  });

  it("still rejects public HTTP origins when the owner opts in", () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    expect(() =>
      normalizeSecretDestination({ ...lanDestination, origin: "http://api.example.test" }),
    ).toThrow();
  });

  it("names the failing field instead of a generic instruction", () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    expect(() =>
      normalizeSecretDestination({
        name: "Feishu Creds",
        origin: "http://192.168.2.10:8080",
        auth: { type: "bearer" as const },
      }),
    ).toThrow(/name/);
  });

  it("reports login-over-plain-HTTP as an origin problem", () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    expect(() =>
      normalizeSecretDestination({
        name: "feishu_app_credentials",
        origin: "http://192.168.2.10:8080",
        auth: { type: "login" as const },
      }),
    ).toThrow(/Website logins require an HTTPS origin/);
  });
});

describe("saved website logins", () => {
  const login = {
    name: "site_login",
    origin: "https://login.example.test",
    auth: { type: "login" },
  };
  async function loginFixture(username: string, auth: object = login.auth, origin = login.origin) {
    const plaintext = encodeLoginSecret({ username, password: "fake-password-1" });
    const encrypted = await secretStore.put(
      plaintext,
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      "login-1",
    );
    const row = { ...scope, ...login, origin, auth, ...encrypted };
    const findFirst = vi.fn(async ({ where }) =>
      Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)
        ? row
        : null,
    );
    return { prisma: { botSecret: { findFirst } } as unknown as PrismaClient };
  }

  it("resolves one field bound to the saved origin with its redactions", async () => {
    const { prisma } = await loginFixture("fake-user@example.test");
    const input = { prisma, secretStore, scope, name: "site_login" };
    expect(await resolveLoginFill({ ...input, field: "password" })).toEqual({
      text: "fake-password-1",
      origin: "https://login.example.test",
      redactions: expect.arrayContaining(["fake-password-1", "fake-user@example.test"]),
    });
    expect(await resolveLoginFill({ ...input, field: "username" })).toMatchObject({
      text: "fake-user@example.test",
    });
  });

  it("does not redact a short username that would mangle unrelated text", async () => {
    const { prisma } = await loginFixture("ada");
    const resolved = await resolveLoginFill({
      prisma,
      secretStore,
      scope,
      name: "site_login",
      field: "username",
    });
    expect(resolved).toMatchObject({ text: "ada" });
    expect("redactions" in resolved && resolved.redactions).not.toContain("ada");
  });

  it("is never sent as an HTTP credential", async () => {
    const { prisma } = await loginFixture("fake-user@example.test");
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(
      await requestWithBotSecret({
        prisma,
        secretStore,
        scope,
        request: { name: "site_login", url: `${login.origin}/api` },
        signal: new AbortController().signal,
        remote: { fetch, resolveHostname: publicResolver },
      }),
    ).toEqual({ error: expect.stringContaining("browser_act") });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to fill a login saved on plain HTTP, including a private LAN origin", async () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const { prisma } = await loginFixture(
      "fake-user@example.test",
      login.auth,
      "http://192.168.2.10:8080",
    );
    expect(
      await resolveLoginFill({
        prisma,
        secretStore,
        scope,
        name: "site_login",
        field: "password",
      }),
    ).toEqual({ error: "Website logins can only be filled on an HTTPS origin." });
  });

  it("refuses to fill a credential that is not a login", async () => {
    const { input } = await fixture();
    expect(await resolveLoginFill({ ...input, name: destination.name, field: "password" })).toEqual(
      { error: "This credential is not a website login." },
    );
  });
});
