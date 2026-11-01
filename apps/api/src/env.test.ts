import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgres://rakazo:rakazo@127.0.0.1:5433/rakazo",
  NODE_ENV: "test",
};

describe("loadEnv", () => {
  it("defaults the attachment count to four and accepts configured bounds", () => {
    expect(loadEnv(base).maxAttachmentsPerMessage).toBe(4);
    expect(loadEnv({ ...base, MAX_ATTACHMENTS_PER_MESSAGE: " " }).maxAttachmentsPerMessage).toBe(4);
    for (const count of [1, 8, 100]) {
      expect(
        loadEnv({ ...base, MAX_ATTACHMENTS_PER_MESSAGE: ` ${count} ` }).maxAttachmentsPerMessage,
      ).toBe(count);
    }
  });
  it.each(["0", "1e2", "101"])("rejects invalid attachment count %s", (value) => {
    expect(() => loadEnv({ ...base, MAX_ATTACHMENTS_PER_MESSAGE: value })).toThrow(
      "MAX_ATTACHMENTS_PER_MESSAGE",
    );
  });

  it("keeps calls off unless explicitly enabled", () => {
    expect(loadEnv(base).phoneCallsEnabled).toBe(false);
    for (const value of ["false", "1", ""]) {
      expect(loadEnv({ ...base, PHONE_CALLS_ENABLED: value }).phoneCallsEnabled).toBe(false);
    }
    expect(loadEnv({ ...base, PHONE_CALLS_ENABLED: "true" }).phoneCallsEnabled).toBe(true);
  });
  it("parses the call ring window and falls back for invalid values", () => {
    expect(loadEnv(base).phoneCallRingSeconds).toBe(45);
    expect(loadEnv({ ...base, PHONE_CALL_RING_SECONDS: "90" }).phoneCallRingSeconds).toBe(90);
    for (const value of ["", "0", "-1", "invalid", "NaN", "Infinity"]) {
      expect(loadEnv({ ...base, PHONE_CALL_RING_SECONDS: value }).phoneCallRingSeconds).toBe(45);
    }
  });

  it("defaults uploads to 10 MiB and parses a configured limit", () => {
    expect(loadEnv(base).maxUploadSizeBytes).toBe(10 * 1024 * 1024);
    expect(loadEnv({ ...base, MAX_UPLOAD_SIZE_MB: "" }).maxUploadSizeBytes).toBe(10 * 1024 * 1024);
    expect(loadEnv({ ...base, MAX_UPLOAD_SIZE_MB: " 25 " }).maxUploadSizeBytes).toBe(
      25 * 1024 * 1024,
    );
  });

  it.each(["0", "1e3", "9007199254740991"])("rejects invalid upload limit %s", (value) => {
    expect(() => loadEnv({ ...base, MAX_UPLOAD_SIZE_MB: value })).toThrow("MAX_UPLOAD_SIZE_MB");
  });
  it("keeps the ticket board off unless explicitly enabled", () => {
    expect(loadEnv(base).ticketBoardEnabled).toBe(false);
    for (const value of ["false", "1", ""])
      expect(loadEnv({ ...base, TICKET_BOARD_ENABLED: value }).ticketBoardEnabled).toBe(false);
    expect(loadEnv({ ...base, TICKET_BOARD_ENABLED: "true" }).ticketBoardEnabled).toBe(true);
  });
  it("loads operator menu links and refuses to start on a bad value", () => {
    expect(loadEnv(base).navLinks).toEqual([]);
    expect(
      loadEnv({
        ...base,
        RAKAZO_NAV_LINKS: '[{"id":"clients","label":"Clients","path":"/ext/clients/"}]',
      }).navLinks,
    ).toEqual([{ id: "clients", label: "Clients", path: "/ext/clients/", trusted: false }]);
    expect(() =>
      loadEnv({ ...base, RAKAZO_NAV_LINKS: '[{"id":"x","label":"X","path":"/api/me"}]' }),
    ).toThrow("RAKAZO_NAV_LINKS");
  });
  it("keeps Crisp chat off unless a valid website ID is set", () => {
    expect(loadEnv(base).crispWebsiteId).toBeNull();
    expect(
      loadEnv({ ...base, CRISP_WEBSITE_ID: "c2c27ea6-4fdb-4350-a9fc-4b5b052dc5ec" }).crispWebsiteId,
    ).toBe("c2c27ea6-4fdb-4350-a9fc-4b5b052dc5ec");
    expect(() => loadEnv({ ...base, CRISP_WEBSITE_ID: "nope" })).toThrow("CRISP_WEBSITE_ID");
  });
  it("defaults the product path to Pi, Docker, and Graphile Worker", () => {
    const env = loadEnv(base);
    expect(env.agentRuntime).toBe("pi");
    expect(env.sandboxProvider).toBe("docker");
    expect(env.wakeupDriver).toBe("graphile");
    expect(env.apiHost).toBe("127.0.0.1");
    expect(env.nodeEnv).toBe("test");
  });

  it("defaults Pi JSONL session recording to off", () => {
    expect(loadEnv(base).piSessionRecording).toBe(false);
    expect(loadEnv({ ...base, PI_SESSION_RECORDING: "false" }).piSessionRecording).toBe(false);
    expect(loadEnv({ ...base, PI_SESSION_RECORDING: "1" }).piSessionRecording).toBe(false);
    expect(loadEnv({ ...base, PI_SESSION_RECORDING: "true" }).piSessionRecording).toBe(true);
  });

  it("keeps explicit emulator settings for pnpm test", () => {
    const env = loadEnv({
      ...base,
      AGENT_RUNTIME: "scripted",
      SANDBOX_PROVIDER: "fake",
      WAKEUP_DRIVER: "memory",
    });
    expect(env.agentRuntime).toBe("scripted");
    expect(env.sandboxProvider).toBe("fake");
    expect(env.wakeupDriver).toBe("memory");
  });

  it("loads an optional integrations catalog mirror", () => {
    expect(loadEnv(base).integrationsCatalogUrl).toBeUndefined();
    expect(
      loadEnv({ ...base, INTEGRATIONS_CATALOG_URL: " https://catalog.example.test/feed " })
        .integrationsCatalogUrl,
    ).toBe("https://catalog.example.test/feed");
  });

  it("falls back to none when a remote provider key is missing", () => {
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "e2b",
      }).sandboxProvider,
    ).toBe("none");
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "createos",
      }).sandboxProvider,
    ).toBe("none");
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "none",
      }).sandboxProvider,
    ).toBe("none");
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "",
      }).sandboxProvider,
    ).toBe("none");
  });

  it("loads provider-specific Daytona configuration", () => {
    const env = loadEnv({
      ...base,
      SANDBOX_PROVIDER: "daytona",
      DAYTONA_API_KEY: "test-daytona-key",
      DAYTONA_API_URL: "https://daytona.test/api",
      DAYTONA_TARGET: "test-target",
    });
    expect(env).toMatchObject({
      sandboxProvider: "daytona",
      daytonaApiKey: "test-daytona-key",
      daytonaApiUrl: "https://daytona.test/api",
      daytonaTarget: "test-target",
    });
  });

  it("loads Novita credentials and the shared sandbox template", () => {
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "novita",
        NOVITA_API_KEY: "test-novita-key",
        SANDBOX_TEMPLATE: "custom-desktop",
      }),
    ).toMatchObject({
      sandboxProvider: "novita",
      novitaApiKey: "test-novita-key",
      sandboxTemplate: "custom-desktop",
    });
    expect(
      loadEnv({ ...base, SANDBOX_PROVIDER: "novita", E2B_API_KEY: "test-e2b-key" }).sandboxProvider,
    ).toBe("none");
  });

  it("loads provider-specific Boat configuration", () => {
    const env = loadEnv({
      ...base,
      SANDBOX_PROVIDER: "boat",
      BOAT_API_KEY: "test-boat-key",
      BOAT_API_URL: "https://boat.test/api/v1",
    });
    expect(env).toMatchObject({
      sandboxProvider: "boat",
      boatApiKey: "test-boat-key",
      boatApiUrl: "https://boat.test/api/v1",
    });
  });

  it("throws when production omits secrets", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("throws when production uses placeholder secrets", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "dev-secret-change-me-please-32chars",
        ENCRYPTION_KEY: "real-encryption-key-value",
        SANDBOX_SUPERVISOR_TOKEN: "real-supervisor-token-with-enough-length",
        SCREEN_PROXY_SECRET: "real-screen-proxy-secret-with-enough-length",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("loads real secrets in production", () => {
    const env = loadEnv({
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
      SANDBOX_PROVIDER: "e2b",
      API_HOST: "0.0.0.0",
    });
    expect(env.authSecret).toBe("prod-auth-secret-with-enough-length");
    expect(env.encryptionKey).toBe("prod-encryption-key-with-enough-length");
    expect(env.sandboxSupervisorToken).toBeUndefined();
    expect(env.screenProxySecret).toBe("prod-screen-proxy-secret-with-enough-length");
    expect(env.apiHost).toBe("0.0.0.0");
  });

  it("encrypts content on servers by default and fails startup on an invalid switch", () => {
    const production = {
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
      SANDBOX_PROVIDER: "e2b",
    };
    expect(loadEnv(production).contentEncryption).toBe(true);
    expect(loadEnv({ ...production, CONTENT_ENCRYPTION: "off" }).contentEncryption).toBe(false);
    expect(
      loadEnv({ DATABASE_URL: base.DATABASE_URL, NODE_ENV: "development" }).contentEncryption,
    ).toBe(false);
    expect(() => loadEnv({ ...production, CONTENT_ENCRYPTION: "maybe" })).toThrow(
      /CONTENT_ENCRYPTION must be "on" or "off"/,
    );
  });

  it("falls back to none in production when Docker has no supervisor token", () => {
    const env = loadEnv({
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
      SANDBOX_PROVIDER: "docker",
    });
    expect(env.sandboxProvider).toBe("none");
    expect(env.sandboxSupervisorToken).toBeUndefined();
  });

  it("requires a dedicated supervisor token when Docker stays selected", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
        SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
        SANDBOX_PROVIDER: "docker",
        SANDBOX_SUPERVISOR_TOKEN: "too-short",
      }),
    ).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);
  });

  it("exposes a deployed git revision when GIT_SHA is set", () => {
    expect(loadEnv(base).gitSha).toBeUndefined();
    expect(loadEnv({ ...base, GIT_SHA: "  3c6e209  " }).gitSha).toBe("3c6e209");
    expect(loadEnv({ ...base, RAKAZO_GIT_SHA: "abc1234" }).gitSha).toBe("abc1234");
  });

  it("loads per-client minimum builds and refuses a malformed one", () => {
    expect(loadEnv(base).minimumClientBuilds).toEqual({});
    expect(
      loadEnv({ ...base, RAKAZO_MIN_CLIENT_BUILD: "web=20261022093015" }).minimumClientBuilds,
    ).toEqual({ web: "20261022093015" });
    expect(() => loadEnv({ ...base, RAKAZO_MIN_CLIENT_BUILD: "latest" })).toThrow(
      /RAKAZO_MIN_CLIENT_BUILD/,
    );
  });

  it("loads an optional Expo access token", () => {
    expect(loadEnv(base).expoAccessToken).toBeUndefined();
    expect(loadEnv({ ...base, EXPO_ACCESS_TOKEN: " fake-expo-token " }).expoAccessToken).toBe(
      "fake-expo-token",
    );
  });

  it("loads SMTP configuration and keeps the email emulator out of production", () => {
    expect(
      loadEnv({
        ...base,
        SMTP_URL: " smtps://user:secret@smtp.example.test:465 ",
        EMAIL_FROM: " Rakazo <no-reply@example.test> ",
        EMAIL_EMULATOR: "true",
      }),
    ).toMatchObject({
      smtpUrl: "smtps://user:secret@smtp.example.test:465",
      emailFrom: "Rakazo <no-reply@example.test>",
      emailEmulator: true,
    });
    expect(
      loadEnv({
        ...base,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
        SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
        SANDBOX_PROVIDER: "none",
        EMAIL_EMULATOR: "true",
      }).emailEmulator,
    ).toBe(false);
    expect(loadEnv({ ...base, NODE_ENV: "development" }).nodeEnv).toBe("development");
  });

  it("loads generic email API connection settings", () => {
    expect(
      loadEnv({ ...base, EMAIL_PROVIDER: " resend ", EMAIL_API_KEY: " fake-key " }),
    ).toMatchObject({
      emailProvider: "resend",
      emailApiKey: "fake-key",
    });
    expect(loadEnv(base).emailProvider).toBeUndefined();
    expect(loadEnv(base).emailApiKey).toBeUndefined();
  });

  it("defaults the remote MCP private-endpoint escape to off", () => {
    expect(loadEnv(base).mcpAllowPrivateEndpoint).toBe(false);
    expect(loadEnv({ ...base, MCP_ALLOW_PRIVATE_ENDPOINT: "true" }).mcpAllowPrivateEndpoint).toBe(
      true,
    );
    expect(loadEnv({ ...base, MCP_ALLOW_PRIVATE_ENDPOINT: "1" }).mcpAllowPrivateEndpoint).toBe(
      false,
    );
  });
});

describe("OIDC environment", () => {
  const oidc = {
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_CLIENT_ID: "fake-client",
    OIDC_CLIENT_SECRET: "fake-secret",
  };
  it("requires all credentials and an HTTPS issuer", () => {
    for (const [key, value] of Object.entries(oidc))
      expect(() => loadEnv({ ...base, [key]: value })).toThrow(/configured together/);
    expect(() =>
      loadEnv({ ...base, ...oidc, OIDC_ISSUER: "http://identity.example.test" }),
    ).toThrow(/HTTPS/);
  });
  it.each(["identity.example.test", "/issuer", "https://"])(
    "reports invalid issuer %s as a configuration error",
    (issuer) => {
      expect(() => loadEnv({ ...base, ...oidc, OIDC_ISSUER: issuer })).toThrow(
        "OIDC_ISSUER must be an HTTPS issuer URL",
      );
    },
  );
  it("guards password-only lockout without contacting discovery", () => {
    expect(() => loadEnv({ ...base, AUTH_PASSWORD_ENABLED: "false" })).toThrow(/requires OIDC/);
    expect(loadEnv({ ...base, ...oidc, AUTH_PASSWORD_ENABLED: "false" }).passwordAuth).toBe(false);
  });
  it("leaves the breached password check off unless explicitly enabled", () => {
    expect(loadEnv(base).breachedPasswordCheck).toBe(false);
    expect(
      loadEnv({ ...base, AUTH_BREACHED_PASSWORD_CHECK_ENABLED: "true" }).breachedPasswordCheck,
    ).toBe(true);
    expect(() => loadEnv({ ...base, AUTH_BREACHED_PASSWORD_CHECK_ENABLED: "yes" })).toThrow(
      "AUTH_BREACHED_PASSWORD_CHECK_ENABLED must be true or false",
    );
  });
  it("defaults to SSO with no policy bypass", () => {
    expect(loadEnv({ ...base, ...oidc }).oidc).toMatchObject({
      name: "SSO",
      allowSignupBypass: false,
      scopes: ["openid", "email", "profile"],
    });
    expect(
      loadEnv({ ...base, ...oidc, OIDC_ALLOW_SIGNUP_BYPASS: "true" }).oidc?.allowSignupBypass,
    ).toBe(true);
  });
});
