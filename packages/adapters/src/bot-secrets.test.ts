import type { BotSecretDestination } from "@rakazo/contracts";
import { BOT_SECRET_ORIGIN_MISSING_MESSAGE, encodeLoginSecret } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import * as Logging from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  credentialArgument,
  encodeRunLogin,
  loadLoginPasswordRedactions,
  loadRunLoginRedactions,
  normalizeSecretDestination,
  requestWithBotSecret,
  resolveLoginFill,
  resolveRequestSecretDestination,
  sameSecretDestination,
} from "./bot-secrets.js";
import { EncryptedSecretStore } from "./secrets.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const scope = { userId: "user-1", spaceId: "space-1" };
// These rows sit in the Space's own vault, so lookups match their spaceId.
const ownVault = { findUnique: vi.fn(async () => ({ setting: "credentials" })) };
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
    { recordId: "secret-1" },
  );
  const row = { ...scope, ...destination, auth, ...encrypted };
  const findFirst = vi.fn(async ({ where }) =>
    Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)
      ? row
      : null,
  );
  const prisma = {
    spaceSettingOverride: ownVault,
    vaultCredential: { findFirst },
    secret: { findFirst: vi.fn(async () => null) },
  } as unknown as PrismaClient;
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
  it("starts the request deadline before loading the credential", async () => {
    const { input, fetch } = await fixture();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let credentialSignal: AbortSignal | undefined;
    const load = vi.spyOn(secretStore, "load").mockImplementationOnce(async (_ref, context) => {
      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(typeof context).toBe("object");
      if (typeof context === "string") throw new Error("Missing signal");
      expect(context.signal).not.toBe(input.signal);
      credentialSignal = context.signal;
      return secret;
    });
    try {
      await requestWithBotSecret(input);
      expect(fetch.mock.calls[0]?.[1]?.signal).toBe(credentialSignal);
    } finally {
      load.mockRestore();
      timeout.mockRestore();
    }
  });
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

  it.each(["userId", "spaceId"] as const)(
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
      { recordId: "secret-2" },
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
      prisma: {
        spaceSettingOverride: ownVault,
        vaultCredential: { findFirst },
      } as unknown as PrismaClient,
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
      { recordId: "secret-3" },
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
      prisma: {
        spaceSettingOverride: ownVault,
        vaultCredential: { findFirst },
      } as unknown as PrismaClient,
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

describe("resolveRequestSecretDestination", () => {
  const documented = {
    label: "API key",
    purpose: "api_key",
    credential: destination,
  };
  const plantedSecret = "not-a-real-secret-value";

  it("keeps command destinations metadata-only with an omitted or empty origin", () => {
    for (const origin of [undefined, ""]) {
      const resolved = resolveRequestSecretDestination({
        credential: {
          name: "cli-token",
          origin,
          auth: { type: "command", value: plantedSecret },
          value: plantedSecret,
        },
      });
      expect(resolved).toEqual({
        destination: { name: "cli-token", origin: "", auth: { type: "command" } },
      });
      expect(JSON.stringify(resolved)).not.toContain(plantedSecret);
    }
  });

  it("accepts the documented credential shape", () => {
    expect(resolveRequestSecretDestination(documented)).toEqual({ destination });
  });

  it("accepts a valid credential object supplied beside connectionId", () => {
    // The flattened tool schema allows both fields.
    const resolved = resolveRequestSecretDestination({
      ...documented,
      connectionId: "conn_1",
      credential: { ...destination, value: plantedSecret },
    });
    expect(resolved).toEqual({ destination });
    expect(resolved.connectionId).toBeUndefined();
    expect(JSON.stringify(resolved)).not.toContain(plantedSecret);
    expect(resolved.error).toBeUndefined();
  });

  it("accepts a credential object supplied as top-level name, origin, and auth", () => {
    expect(
      resolveRequestSecretDestination({
        label: "API key",
        purpose: "api_key",
        name: destination.name,
        origin: destination.origin,
        auth: destination.auth,
        secret: plantedSecret,
      }),
    ).toEqual({ destination });
  });

  it("accepts a credential object supplied as a JSON string", () => {
    expect(
      resolveRequestSecretDestination({
        label: "API key",
        purpose: "api_key",
        credential: JSON.stringify({ ...destination, value: plantedSecret }),
      }),
    ).toEqual({ destination });
  });

  it("accepts the documented website login shape", () => {
    const login = {
      name: "example_login",
      origin: "https://login.example.test",
      auth: { type: "login" as const },
    };
    expect(
      resolveRequestSecretDestination({
        label: "Example sign-in",
        purpose: "password",
        credential: login,
      }),
    ).toEqual({ destination: login });
  });

  it("keeps the connector path when only connectionId is supplied", () => {
    expect(
      resolveRequestSecretDestination({
        label: "Code",
        purpose: "otp",
        connectionId: " conn_1 ",
      }),
    ).toEqual({ connectionId: "conn_1" });
  });

  it("does not treat a blank connectionId as a second destination", () => {
    expect(resolveRequestSecretDestination({ ...documented, connectionId: "  " })).toEqual({
      destination,
    });
    expect(
      resolveRequestSecretDestination({ label: "Code", purpose: "otp", connectionId: "null" }),
    ).toEqual({
      error: "Provide either a reusable credential destination or a connectionId.",
    });
  });

  it("names the failing credential field instead of asking for a destination again", () => {
    const resolved = resolveRequestSecretDestination({
      label: "API key",
      purpose: "api_key",
      credential: { ...destination, name: "Bad Name" },
      connectionId: "conn_1",
    });
    expect(resolved.destination).toBeUndefined();
    expect(resolved.connectionId).toBeUndefined();
    expect(resolved.error).toMatch(/Invalid credential destination — name:/);
    expect(resolved.error).not.toMatch(/reusable credential destination/);
    expect(resolved.error).not.toBe("Specify a credential name, HTTPS origin, and auth method.");
  });

  it("rejects a partial top-level credential instead of using connectionId", () => {
    const withConnection = resolveRequestSecretDestination({
      label: "API key",
      purpose: "api_key",
      name: destination.name,
      origin: destination.origin,
      connectionId: "conn_1",
    });
    const withoutConnection = resolveRequestSecretDestination({
      label: "API key",
      purpose: "api_key",
      name: destination.name,
      origin: destination.origin,
    });
    expect(withConnection.connectionId).toBeUndefined();
    expect(withConnection.destination).toBeUndefined();
    expect(withConnection.error).toMatch(/Invalid credential destination — auth:/);
    expect(withoutConnection).toEqual({ error: withConnection.error });
  });

  it("keeps a complete top-level credential ahead of connectionId", () => {
    expect(
      resolveRequestSecretDestination({
        name: destination.name,
        origin: destination.origin,
        auth: destination.auth,
        connectionId: "conn_1",
        secret: plantedSecret,
      }),
    ).toEqual({ destination });
  });

  it("prefers a nested credential over connectionId and a partial top-level destination", () => {
    expect(
      resolveRequestSecretDestination({
        credential: destination,
        name: destination.name,
        origin: destination.origin,
        connectionId: "conn_1",
      }),
    ).toEqual({ destination });
    expect(
      resolveRequestSecretDestination({
        credential: JSON.stringify(destination),
        name: "only_name",
        connectionId: "conn_1",
      }),
    ).toEqual({ destination });
  });
});

describe("credentialArgument", () => {
  const plantedSecret = "planted-secret-value";

  it("drops planted secret fields from an object credential", () => {
    const credential = credentialArgument({
      credential: { ...destination, value: plantedSecret, secret: plantedSecret },
    });
    expect(credential).toEqual(destination);
    expect(JSON.stringify(credential)).not.toContain(plantedSecret);
  });

  it("drops planted secret fields from a JSON-string credential", () => {
    const credential = credentialArgument({
      credential: JSON.stringify({
        ...destination,
        value: plantedSecret,
        secret: plantedSecret,
        password: plantedSecret,
        plaintext: plantedSecret,
      }),
    });
    expect(credential).toEqual(destination);
    expect(JSON.stringify(credential)).not.toContain(plantedSecret);
  });

  it("returns a partial top-level destination so the missing field can be named", () => {
    expect(
      credentialArgument({
        name: destination.name,
        origin: destination.origin,
        connectionId: "conn_1",
        secret: plantedSecret,
      }),
    ).toEqual({ name: destination.name, origin: destination.origin });
  });

  it("drops secret fields nested in auth instead of keeping the original object", () => {
    const auth = {
      type: "bearer" as const,
      token: plantedSecret,
      value: plantedSecret,
      headers: { Authorization: plantedSecret },
    };
    const credential = credentialArgument({
      credential: { ...destination, auth, secret: plantedSecret },
    });
    expect(credential).toEqual(destination);
    expect(JSON.stringify(credential)).not.toContain(plantedSecret);
    auth.token = "changed-after-copy";
    expect(credential).toEqual(destination);

    expect(
      credentialArgument({
        name: destination.name,
        origin: destination.origin,
        auth: { type: "header", name: "X-Api-Key", value: plantedSecret },
      }),
    ).toEqual({
      ...destination,
      auth: { type: "header", name: "X-Api-Key" },
    });
    expect(
      credentialArgument({
        credential: {
          name: "example_basic",
          origin: destination.origin,
          auth: { type: "basic", username: "bot", password: plantedSecret },
        },
      }),
    ).toEqual({
      name: "example_basic",
      origin: destination.origin,
      auth: { type: "basic", username: "bot" },
    });
    expect(
      credentialArgument({
        credential: JSON.stringify({
          name: "example_login",
          origin: "https://login.example.test",
          auth: { type: "login", username: plantedSecret, password: plantedSecret },
        }),
      }),
    ).toEqual({
      name: "example_login",
      origin: "https://login.example.test",
      auth: { type: "login" },
    });
  });

  it("omits auth that does not parse, and other values that are not destination metadata", () => {
    expect(
      credentialArgument({
        credential: {
          name: destination.name,
          origin: destination.origin,
          auth: { token: plantedSecret },
        },
      }),
    ).toEqual({
      name: destination.name,
      origin: destination.origin,
      auth: { type: "invalid" },
    });
    const invalidMethod = credentialArgument({
      credential: { ...destination, auth: { type: "cookie", token: plantedSecret } },
    });
    expect(invalidMethod).toEqual({ ...destination, auth: { type: "invalid" } });
    expect(JSON.stringify(invalidMethod)).not.toContain(plantedSecret);
    expect(
      resolveRequestSecretDestination({
        credential: { ...destination, auth: { type: "cookie", token: plantedSecret } },
      }).error,
    ).toMatch(/auth\.type:/);
    expect(
      credentialArgument({
        credential: {
          ...destination,
          auth: { type: "header", name: "Cookie", value: plantedSecret },
        },
      }),
    ).toEqual({ ...destination, auth: { type: "header", name: "Cookie" } });
    expect(
      resolveRequestSecretDestination({
        credential: {
          ...destination,
          auth: { type: "header", name: "Cookie", value: plantedSecret },
        },
      }).error,
    ).toMatch(/Unsupported credential header/);

    expect(
      credentialArgument({
        credential: {
          name: { value: plantedSecret },
          origin: { href: `https://user:${plantedSecret}@api.example.test` },
          auth: destination.auth,
        },
      }),
    ).toEqual({ auth: destination.auth });

    expect(credentialArgument({ credential: plantedSecret })).toEqual({});
    expect(credentialArgument({ credential: `{not-json ${plantedSecret}}` })).toEqual({});
    expect(credentialArgument({ credential: [plantedSecret] })).toEqual({});
    expect(JSON.stringify(credentialArgument({ credential: plantedSecret }))).not.toContain(
      plantedSecret,
    );
  });

  it("removes credentials embedded in an origin before they can be recorded", () => {
    const credential = credentialArgument({
      credential: {
        ...destination,
        origin: `https://user:${plantedSecret}@api.example.test/v1?token=${plantedSecret}#${plantedSecret}`,
      },
    });
    expect(credential).toEqual(destination);
    expect(JSON.stringify(credential)).not.toContain(plantedSecret);

    const secretName = "Planted.Secret";
    const replaced = credentialArgument({
      credential: { ...destination, name: secretName, origin: secretName },
    });
    expect(replaced).toEqual({
      name: "Invalid Name",
      origin: "invalid-origin",
      auth: destination.auth,
    });
    expect(JSON.stringify(replaced)).not.toContain(secretName);
    expect(
      resolveRequestSecretDestination({
        label: "API key",
        purpose: "api_key",
        credential: { ...destination, name: secretName },
      }).error,
    ).toMatch(/Invalid credential destination — name:/);
    // A page URL is saved under its site, and its path is never kept.
    const fromPage = resolveRequestSecretDestination({
      label: "API key",
      purpose: "api_key",
      credential: { ...destination, origin: `https://api.example.test/${secretName}` },
    });
    expect(fromPage).toEqual({ destination });
    expect(JSON.stringify(fromPage)).not.toContain(secretName);

    expect(
      resolveRequestSecretDestination({
        label: "API key",
        purpose: "api_key",
        credential: {
          ...destination,
          origin: `https://user:${plantedSecret}@api.example.test?token=${plantedSecret}`,
          auth: { ...destination.auth, token: plantedSecret },
        },
      }),
    ).toEqual({ destination });

    for (const origin of [
      `https://api.example.test/${plantedSecret}/..`,
      `https://api.example.test/${plantedSecret}/%2e%2e`,
    ]) {
      const collapsed = credentialArgument({ credential: { ...destination, origin } });
      expect(collapsed).toEqual(destination);
      expect(JSON.stringify(collapsed)).not.toContain(plantedSecret);
    }
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

  it("says a login's origin is missing when the model leaves it out", () => {
    expect(() =>
      normalizeSecretDestination({ name: "example-login", auth: { type: "login" } }),
    ).toThrow(`origin: ${BOT_SECRET_ORIGIN_MISSING_MESSAGE}`);
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

  function requestedOrigin(origin: string, auth: object = { type: "login" }) {
    const resolved = resolveRequestSecretDestination({
      label: "Sign in",
      purpose: "password",
      credential: { name: "site_login", origin, auth },
    });
    return resolved.destination?.origin ?? resolved.error;
  }

  it("saves a credential requested with a page URL under that page's site", () => {
    expect(requestedOrigin("https://www.example.test/some/login/page?x=1")).toBe(
      "https://www.example.test",
    );
    expect(requestedOrigin("https://api.example.test/v1/users#top", { type: "bearer" })).toBe(
      "https://api.example.test",
    );
    expect(requestedOrigin("https://WWW.Example.TEST:443/Login")).toBe("https://www.example.test");
    expect(requestedOrigin("https://api.example.test:8443/v1")).toBe(
      "https://api.example.test:8443",
    );
    // The host is kept as the browser reports it: punycode, and a trailing dot as its own site.
    expect(requestedOrigin("https://bücher.example.test/login")).toBe(
      "https://xn--bcher-kva.example.test",
    );
    expect(requestedOrigin("https://www.example.test./login")).toBe("https://www.example.test.");
    // A long sign-in redirect URL is fine; only the site is kept.
    expect(requestedOrigin(`https://www.example.test/sign-in?state=${"a".repeat(3000)}`)).toBe(
      "https://www.example.test",
    );
  });

  it("reuses a login saved by origin when it is asked for again by page URL", () => {
    const saved: BotSecretDestination = {
      name: "site_login",
      origin: "https://www.example.test",
      auth: { type: "login" },
    };
    const asked = (origin: string) =>
      resolveRequestSecretDestination({
        label: "Sign in",
        purpose: "password",
        credential: { ...saved, origin },
      }).destination!;
    expect(sameSecretDestination(saved, asked("https://www.example.test/account/login?x=1"))).toBe(
      true,
    );
    expect(sameSecretDestination(saved, asked("https://example.test/account/login"))).toBe(false);
  });

  it("still turns down page URLs on sites a credential can't be saved for", () => {
    for (const origin of [
      "http://www.example.test/login",
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.google.internal/x",
      "blob:https://www.example.test/abc",
      "data:text/html,https://www.example.test/",
      "javascript:alert(1)",
      "not a url",
      `https://www.example.test/?state=${"a".repeat(8192)}`,
    ]) {
      const error = requestedOrigin(origin);
      expect(error).toMatch(/^Invalid credential destination — origin: /);
      expect(error).not.toContain("example.test/");
    }
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    expect(requestedOrigin("http://192.168.2.10:8080/api/v1", { type: "bearer" })).toBe(
      "http://192.168.2.10:8080",
    );
    expect(requestedOrigin("http://192.168.2.10:8080/api/v1")).toMatch(
      /Website logins require an HTTPS origin/,
    );
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

/** Prisma's where for these tests: plain fields, a JSON path filter on auth, and take. */
function matchingRows<T extends Record<string, unknown>>(
  rows: T[],
  { where, take }: { where: Record<string, unknown>; take?: number },
) {
  const matches = rows.filter((row) =>
    Object.entries(where).every(([key, value]) => {
      if (key === "auth" && value && typeof value === "object" && "path" in value) {
        const filter = value as { path: string[]; equals: unknown };
        return (row.auth as Record<string, unknown>)[filter.path[0]!] === filter.equals;
      }
      return row[key] === value;
    }),
  );
  return take === undefined ? matches : matches.slice(0, take);
}

describe("saved website logins", () => {
  const login = {
    name: "site_login",
    origin: "https://login.example.test",
    auth: { type: "login" },
  };
  // Stored as logins were before fields, so these tests also cover that old logins fill as before.
  async function loginFixture(
    username: string,
    auth: object = login.auth,
    origin = login.origin,
    password = "fake-password-1",
    plaintext = JSON.stringify({ username, password }),
  ) {
    const encrypted = await secretStore.put(
      plaintext,
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      { recordId: "login-1" },
    );
    const row = { ...scope, ...login, origin, auth, ...encrypted };
    const findFirst = vi.fn(async ({ where }) =>
      Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)
        ? row
        : null,
    );
    const findMany = vi.fn(async (query) => matchingRows([row], query));
    return {
      prisma: {
        spaceSettingOverride: ownVault,
        vaultCredential: { findFirst, findMany },
        secret: { findFirst: vi.fn(async () => null) },
      } as unknown as PrismaClient,
    };
  }

  it("hides every saved password when the bot has more than 100 credentials", async () => {
    const context = { operationId: "test", traceId: "test", signal: new AbortController().signal };
    const rows: Record<string, unknown>[] = [];
    // Other credentials are never decrypted for this, so their ciphertext doesn't matter.
    for (let index = 0; index < 120; index += 1)
      rows.push({ ...scope, name: `api_${index}`, auth: { type: "bearer" }, ciphertext: "unused" });
    const password = "fake-late-password-1";
    const encrypted = await secretStore.put(
      JSON.stringify({ username: "fake-user@example.test", password }),
      { ...scope, ...context },
      { recordId: "login-late" },
    );
    rows.push({ ...scope, ...login, ...encrypted });
    const prisma = {
      spaceSettingOverride: ownVault,
      vaultCredential: { findMany: vi.fn(async (query) => matchingRows(rows, query)) },
    } as unknown as PrismaClient;
    expect(await loadLoginPasswordRedactions(prisma, secretStore, scope)).toContain(password);
  });

  it("hides a saved password in its plain, URL, form and base64 forms", async () => {
    const username = "fake-user@example.test";
    const password = "fake pass!word+1";
    const { prisma } = await loginFixture(username, login.auth, login.origin, password);
    const redactions = await loadLoginPasswordRedactions(prisma, secretStore, scope);
    const forms = [
      password,
      encodeURIComponent(password),
      new URLSearchParams({ v: password }).toString().slice(2),
      Buffer.from(password).toString("base64"),
    ];
    expect(forms).toContain("fake+pass%21word%2B1");
    const redacted = redactSecrets([...forms, `Signed in as ${username}`].join("\n"), redactions);
    for (const form of forms) expect(redacted).not.toContain(form);
    // Only the run that fills a login hides its username.
    expect(redacted).toContain(`Signed in as ${username}`);
    expect(
      await loadLoginPasswordRedactions(prisma, secretStore, { ...scope, userId: "user-2" }),
    ).toEqual([]);
  });

  it("leaves a short password to the run that fills it", async () => {
    const { prisma } = await loginFixture(
      "fake-user@example.test",
      login.auth,
      login.origin,
      "abc",
    );
    expect(await loadLoginPasswordRedactions(prisma, secretStore, scope)).toEqual([]);
    const fill = await resolveLoginFill({
      runId: "run-1",
      prisma,
      secretStore,
      scope,
      name: "site_login",
      field: "password",
    });
    expect("redactions" in fill && fill.redactions).toContain("abc");
  });

  it("skips an unreadable login and logs only its id", async () => {
    const row = { ...scope, ...login, id: "login-broken", ciphertext: "not-a-ciphertext" };
    const prisma = {
      spaceSettingOverride: ownVault,
      vaultCredential: { findMany: vi.fn(async () => [row]) },
    } as unknown as PrismaClient;
    const warn = vi.fn();
    const logger = vi.spyOn(Logging, "getLogger").mockReturnValue({ warn } as never);
    try {
      expect(await loadLoginPasswordRedactions(prisma, secretStore, scope)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.any(String), { loginId: "login-broken" });
      // The logger's own scrubbing keeps the id readable.
      expect(Logging.redactBindings(warn.mock.calls[0]![1])).toEqual({ loginId: "login-broken" });
    } finally {
      logger.mockRestore();
    }
  });

  it("decrypts nothing for a bot without saved logins", async () => {
    const { prisma } = await loginFixture("fake-user@example.test", { type: "bearer" });
    const load = vi.spyOn(secretStore, "load");
    try {
      expect(await loadLoginPasswordRedactions(prisma, secretStore, scope)).toEqual([]);
      expect(load).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });

  it("resolves one field bound to the saved origin with its redactions", async () => {
    const { prisma } = await loginFixture("fake-user@example.test");
    const input = { prisma, secretStore, scope, name: "site_login" };
    expect(await resolveLoginFill({ runId: "run-1", ...input, field: "password" })).toEqual({
      text: "fake-password-1",
      hidden: true,
      origin: "https://login.example.test",
      redactions: expect.arrayContaining(["fake-password-1", "fake-user@example.test"]),
    });
    expect(await resolveLoginFill({ runId: "run-1", ...input, field: "username" })).toMatchObject({
      text: "fake-user@example.test",
      hidden: false,
    });
    expect(await resolveLoginFill({ runId: "run-1", ...input, field: "Password" })).toMatchObject({
      text: "fake-password-1",
      hidden: true,
    });
  });

  describe("with named fields", () => {
    const fields = [
      { label: "ID number", value: "fake-id-1234", hidden: false },
      { label: "Phone number", value: "+1 555 0100", hidden: true },
      { label: "PIN", value: "4321", hidden: true },
      { label: "Branch", value: "nyc", hidden: false },
    ];
    const fieldsFixture = () =>
      loginFixture("unused", login.auth, login.origin, "unused", encodeLoginSecret({ fields }));

    it("fills a field by its label, whatever its case, with whether it is hidden", async () => {
      const { prisma } = await fieldsFixture();
      const input = { prisma, secretStore, scope, name: "site_login" };
      expect(
        await resolveLoginFill({ runId: "run-1", ...input, field: "phone NUMBER" }),
      ).toMatchObject({
        text: "+1 555 0100",
        hidden: true,
      });
      expect(
        await resolveLoginFill({ runId: "run-1", ...input, field: "ID number" }),
      ).toMatchObject({
        text: "fake-id-1234",
        hidden: false,
      });
      // A bot that still says username and password gets the first visible and hidden fields.
      expect(await resolveLoginFill({ runId: "run-1", ...input, field: "username" })).toMatchObject(
        {
          text: "fake-id-1234",
        },
      );
      expect(await resolveLoginFill({ runId: "run-1", ...input, field: "password" })).toMatchObject(
        {
          text: "+1 555 0100",
        },
      );
    });

    it("names the login's fields, never their values, when the label isn't one of them", async () => {
      const { prisma } = await fieldsFixture();
      const result = await resolveLoginFill({
        runId: "run-1",
        prisma,
        secretStore,
        scope,
        name: "site_login",
        field: "Email",
      });
      expect(result).toEqual({
        error:
          'This login has no field named "Email". Its fields: ID number, Phone number, PIN, Branch.',
      });
    });

    it("hides every hidden field and the visible ones long enough in the filling run", async () => {
      const { prisma } = await fieldsFixture();
      const result = await resolveLoginFill({
        runId: "run-1",
        prisma,
        secretStore,
        scope,
        name: "site_login",
        field: "Branch",
      });
      const redactions = "redactions" in result ? result.redactions : [];
      for (const value of ["fake-id-1234", "+1 555 0100", "%2B1%20555%200100", "4321"]) {
        expect(redactions).toContain(value);
      }
      expect(redactions).not.toContain("nyc");
    });

    it("hides only hidden fields long enough in every run", async () => {
      const { prisma } = await fieldsFixture();
      const redactions = await loadLoginPasswordRedactions(prisma, secretStore, scope);
      expect(redactions).toEqual(expect.arrayContaining(["+1 555 0100", "%2B1%20555%200100"]));
      for (const value of ["fake-id-1234", "4321", "nyc"]) expect(redactions).not.toContain(value);
    });
  });

  it("does not redact a short username that would mangle unrelated text", async () => {
    const { prisma } = await loginFixture("ada");
    const resolved = await resolveLoginFill({
      runId: "run-1",
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
        runId: "run-1",
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
    expect(
      await resolveLoginFill({
        runId: "run-1",
        ...input,
        name: destination.name,
        field: "password",
      }),
    ).toEqual({ error: "This credential is not a website login." });
  });
});

describe("logins kept for one run", () => {
  const fields = [
    { label: "Username", value: "run-user@example.test", hidden: false },
    { label: "Password", value: "run pass!word+1", hidden: true },
  ];

  async function runLoginFixture(origin = "https://login.example.test") {
    const encrypted = await secretStore.put(
      encodeRunLogin(origin, encodeLoginSecret({ fields })),
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      { ephemeral: true },
    );
    const row = { ...scope, kind: "run-login:run-1:site_login", ...encrypted };
    const matching = (where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) =>
        value && typeof value === "object" && "startsWith" in value
          ? String(row[key as keyof typeof row]).startsWith(String(value.startsWith))
          : row[key as keyof typeof row] === value,
      );
    const saved = await secretStore.put(
      encodeLoginSecret({
        fields: [{ label: "Password", value: "saved-password-1", hidden: true }],
      }),
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      { recordId: "saved-login" },
    );
    return {
      spaceSettingOverride: { findUnique: vi.fn(async () => null) },
      secret: {
        findFirst: vi.fn(async ({ where }) => (matching(where) ? row : null)),
        findMany: vi.fn(async ({ where }) => (matching(where) ? [row] : [])),
      },
      // A saved login under the same name, which this run's login comes before.
      vaultCredential: {
        findFirst: vi.fn(async () => ({
          ...scope,
          name: "site_login",
          origin: "https://login.example.test",
          auth: { type: "login" },
          ...saved,
        })),
      },
    } as unknown as PrismaClient;
  }

  it("fills this run's login before a saved one, only in this run", async () => {
    const prisma = await runLoginFixture();
    const input = { prisma, secretStore, scope, name: "site_login" };
    expect(await resolveLoginFill({ ...input, runId: "run-1", field: "Password" })).toEqual({
      text: "run pass!word+1",
      hidden: true,
      origin: "https://login.example.test",
      redactions: expect.arrayContaining(["run pass!word+1", "run-user@example.test"]),
    });
    // Another run of the bot gets the saved login.
    expect(await resolveLoginFill({ ...input, runId: "run-2", field: "Password" })).toMatchObject({
      text: "saved-password-1",
    });
  });

  it("refuses to fill it off HTTPS", async () => {
    const prisma = await runLoginFixture("http://192.168.1.20");
    expect(
      await resolveLoginFill({
        prisma,
        secretStore,
        scope,
        runId: "run-1",
        name: "site_login",
        field: "Password",
      }),
    ).toEqual({
      error: "Website logins can only be filled on an HTTPS origin.",
    });
  });

  it("hides it from the start of its run in the forms a saved login is hidden in", async () => {
    const prisma = await runLoginFixture();
    const redactions = await loadRunLoginRedactions(prisma, secretStore, scope, "run-1");
    const password = "run pass!word+1";
    const forms = [
      password,
      encodeURIComponent(password),
      new URLSearchParams({ v: password }).toString().slice(2),
      Buffer.from(password).toString("base64"),
      "run-user@example.test",
    ];
    const redacted = redactSecrets(forms.join("\n"), redactions);
    for (const form of forms) expect(redacted).not.toContain(form);
    expect(await loadRunLoginRedactions(prisma, secretStore, scope, "run-2")).toEqual([]);
  });
});
