import { describe, expect, it } from "vitest";
import {
  DEV_AUTH_SECRET_PLACEHOLDER,
  DEV_ENCRYPTION_KEY_PLACEHOLDER,
  hasValidBearerToken,
  resolveAuthSecret,
  resolveEncryptionKey,
  resolveSupervisorToken,
  resolveUpdaterToken,
} from "./secrets-guard.js";

describe("secrets-guard", () => {
  it("allows placeholders in test mode", () => {
    expect(resolveAuthSecret({ NODE_ENV: "test" })).toBe(DEV_AUTH_SECRET_PLACEHOLDER);
    expect(resolveEncryptionKey({ NODE_ENV: "test" })).toBe(DEV_ENCRYPTION_KEY_PLACEHOLDER);
  });

  it("rejects missing secrets outside local/test", () => {
    expect(() => resolveAuthSecret({ NODE_ENV: "production" })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => resolveEncryptionKey({ NODE_ENV: "production" })).toThrow(/ENCRYPTION_KEY/);
  });

  it("rejects placeholder values outside local/test", () => {
    expect(() =>
      resolveAuthSecret({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: DEV_AUTH_SECRET_PLACEHOLDER,
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      resolveEncryptionKey({
        NODE_ENV: "production",
        ENCRYPTION_KEY: DEV_ENCRYPTION_KEY_PLACEHOLDER,
      }),
    ).toThrow(/ENCRYPTION_KEY/);
  });

  it("accepts real secrets in production", () => {
    expect(
      resolveAuthSecret({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-secret-with-enough-entropy-here",
      }),
    ).toBe("prod-secret-with-enough-entropy-here");
  });

  it("falls back supervisor token to auth secret", () => {
    expect(
      resolveSupervisorToken({
        NODE_ENV: "test",
        BETTER_AUTH_SECRET: "custom-auth",
      }),
    ).toBe("custom-auth");
    expect(
      resolveSupervisorToken({
        NODE_ENV: "test",
        SANDBOX_SUPERVISOR_TOKEN: "supervisor-only",
        BETTER_AUTH_SECRET: "custom-auth",
      }),
    ).toBe("supervisor-only");
  });

  it("gives the updater its own token without requiring one to be configured", () => {
    expect(resolveUpdaterToken({ NODE_ENV: "test", BETTER_AUTH_SECRET: "custom-auth" })).toBe(
      "custom-auth",
    );
    // Revoking update authority must not mean rebuilding sandbox access, so the tokens are separate.
    expect(
      resolveUpdaterToken({
        NODE_ENV: "test",
        RAKAZO_UPDATER_TOKEN: "updater-only",
        SANDBOX_SUPERVISOR_TOKEN: "supervisor-only",
        BETTER_AUTH_SECRET: "custom-auth",
      }),
    ).toBe("updater-only");
    expect(
      resolveUpdaterToken({
        NODE_ENV: "test",
        SANDBOX_SUPERVISOR_TOKEN: "supervisor-only",
        BETTER_AUTH_SECRET: "custom-auth",
      }),
    ).toBe("custom-auth");
  });

  it("compares bearer tokens without leaking a length or a prefix match", () => {
    expect(hasValidBearerToken("Bearer secret-token", "secret-token")).toBe(true);
    expect(hasValidBearerToken("Bearer secret-token-longer", "secret-token")).toBe(false);
    expect(hasValidBearerToken("Bearer secret-toke", "secret-token")).toBe(false);
    expect(hasValidBearerToken("secret-token", "secret-token")).toBe(false);
    expect(hasValidBearerToken("Basic secret-token", "secret-token")).toBe(false);
    expect(hasValidBearerToken(undefined, "secret-token")).toBe(false);
  });
});
