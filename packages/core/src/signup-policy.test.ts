import { describe, expect, it } from "vitest";
import {
  emailAllowed,
  parseAllowlist,
  signupPolicyFromEnv,
  signupRequiresEmailVerification,
  signupsOpen,
} from "./signup-policy.js";

describe("signup policy", () => {
  it("identifies pending signup consistently across clients without accepting malformed responses", () => {
    expect(signupRequiresEmailVerification({ token: null })).toBe(true);
    for (const response of [
      undefined,
      null,
      {},
      { token: "session-token" },
      { token: "" },
      { token: false },
    ]) {
      expect(signupRequiresEmailVerification(response)).toBe(false);
    }
  });
  it("allows any email when the list is empty", () => {
    expect(emailAllowed("a@x.com", [])).toBe(true);
  });

  it("matches exact addresses and domains case-insensitively", () => {
    const list = parseAllowlist("You@Example.com,@company.com");
    expect(emailAllowed("you@example.com", list)).toBe(true);
    expect(emailAllowed("dev@company.com", list)).toBe(true);
    expect(emailAllowed("other@x.com", list)).toBe(false);
  });

  it("honors SIGNUPS_ENABLED", () => {
    expect(signupsOpen(undefined)).toBe(true);
    expect(signupsOpen("false")).toBe(false);
  });

  it("builds a normalized policy from environment defaults", () => {
    expect(
      signupPolicyFromEnv({
        signupsEnabled: "false",
        signupAllowlist: " You@Example.com, @company.test ",
      }),
    ).toEqual({ enabled: false, allowlist: ["you@example.com", "@company.test"] });
  });
});
