import { describe, expect, it } from "vitest";
import {
  allowlistedSignupAdmission,
  emailAllowed,
  firstAccountClaimDecision,
  parseAllowlist,
  signupAllowlistBootUpdate,
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

  it("reapplies a non-empty env allowlist and leaves a blank one stored", () => {
    expect(signupAllowlistBootUpdate("old@example.test", " New@Example.test ", true)).toBe(
      "new@example.test",
    );
    expect(
      signupAllowlistBootUpdate(
        "you@example.test,@company.test",
        " you@example.test, @company.test ",
        true,
      ),
    ).toBeNull();
    expect(signupAllowlistBootUpdate("kept@example.test", "", true)).toBeNull();
    expect(signupAllowlistBootUpdate("kept@example.test", "  ,  ", true)).toBeNull();
    expect(signupAllowlistBootUpdate("kept@example.test", undefined, true)).toBeNull();
    expect(signupAllowlistBootUpdate("", "owner@example.test", false)).toBeNull();
  });

  it("lets only the first allowlisted account skip delivery", () => {
    expect(
      allowlistedSignupAdmission({
        allowlistSize: 0,
        hasEmailDelivery: false,
        existingHumanCount: 4,
      }),
    ).toBe("open");
    expect(
      allowlistedSignupAdmission({
        allowlistSize: 1,
        hasEmailDelivery: true,
        existingHumanCount: 0,
      }),
    ).toBe("verify");
    expect(
      allowlistedSignupAdmission({
        allowlistSize: 1,
        hasEmailDelivery: false,
        existingHumanCount: 0,
      }),
    ).toBe("open");
    expect(
      allowlistedSignupAdmission({
        allowlistSize: 1,
        hasEmailDelivery: false,
        existingHumanCount: 1,
      }),
    ).toBe("needs-delivery");
  });

  it("gives the unverified first account one claim and refuses any other human", () => {
    expect(
      firstAccountClaimDecision({
        userId: "user-1",
        ownerUserId: null,
        otherHuman: false,
      }),
    ).toBe("claim");
    expect(
      firstAccountClaimDecision({
        userId: "user-1",
        ownerUserId: "user-1",
        otherHuman: false,
      }),
    ).toBe("renew");
    expect(
      firstAccountClaimDecision({
        userId: "user-2",
        ownerUserId: "user-1",
        otherHuman: false,
      }),
    ).toBe("deny");
    expect(
      firstAccountClaimDecision({
        userId: "user-2",
        ownerUserId: null,
        otherHuman: true,
      }),
    ).toBe("deny");
  });
});
