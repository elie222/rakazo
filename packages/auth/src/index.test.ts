import { describe, expect, it, vi } from "vitest";
import {
  blockedAuthPaths,
  buildTrustedOrigins,
  passwordResetEmail,
  resolveSignupPolicy,
} from "./index.js";

describe("auth policy", () => {
  it("blocks invitation and org-creation paths in version 1", () => {
    expect(blockedAuthPaths.some((path) => path.includes("invite"))).toBe(true);
    expect(blockedAuthPaths.some((path) => path.includes("create"))).toBe(true);
  });
});

describe("buildTrustedOrigins", () => {
  it("adds the localhost twin for a 127.0.0.1 web origin", () => {
    expect(
      buildTrustedOrigins({
        webOrigin: "http://127.0.0.1:5173",
        baseURL: "http://127.0.0.1:5173",
      }),
    ).toEqual(expect.arrayContaining(["http://127.0.0.1:5173", "http://localhost:5173"]));
  });

  it("keeps extraOrigins and does not twin non-loopback hosts", () => {
    expect(
      buildTrustedOrigins({
        webOrigin: "https://app.example.test",
        baseURL: "https://api.example.test",
        extraOrigins: ["https://extra.example.test"],
      }),
    ).toEqual([
      "https://app.example.test",
      "https://api.example.test",
      "https://extra.example.test",
    ]);
  });
});

describe("passwordResetEmail", () => {
  it("keeps the reset URL in text and escapes user-controlled HTML", () => {
    const message = passwordResetEmail(
      { id: "user-1", email: "ada@example.test", name: '<Ada & "team">' },
      "https://rakazo.test/reset-password?token=secret&next=1",
    );

    expect(message).toMatchObject({
      to: "ada@example.test",
      subject: "Reset your Rakazo password",
    });
    expect(message.text).toContain("https://rakazo.test/reset-password?token=secret&next=1");
    expect(message.html).toContain("&lt;Ada &amp; &quot;team&quot;&gt;");
    expect(message.html).toContain("token=secret&amp;next=1");
    expect(message.html).not.toContain('<Ada & "team">');
  });
});

describe("resolveSignupPolicy", () => {
  it("uses environment defaults before deployment settings exist", async () => {
    const prisma = {
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    await expect(
      resolveSignupPolicy(prisma as never, {
        signupsEnabled: "false",
        signupAllowlist: "you@example.com,@company.test",
      }),
    ).resolves.toEqual({
      enabled: false,
      allowlist: ["you@example.com", "@company.test"],
    });
  });

  it("keeps using the environment policy for a pre-upgrade uninitialized row", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn().mockResolvedValue({
          signupsEnabled: true,
          signupAllowlist: "",
          signupPolicyInitialized: false,
        }),
      },
    };
    await expect(
      resolveSignupPolicy(prisma as never, {
        signupsEnabled: "false",
        signupAllowlist: "existing-policy@example.com",
      }),
    ).resolves.toEqual({ enabled: false, allowlist: ["existing-policy@example.com"] });
  });

  it("uses live deployment settings as the effective policy after initial seeding", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn().mockResolvedValue({
          signupsEnabled: false,
          signupAllowlist: "approved@example.com",
          signupPolicyInitialized: true,
        }),
      },
    };
    await expect(
      resolveSignupPolicy(prisma as never, {
        signupsEnabled: "false",
        signupAllowlist: "environment-only@example.com",
      }),
    ).resolves.toEqual({ enabled: false, allowlist: ["approved@example.com"] });
  });
});
