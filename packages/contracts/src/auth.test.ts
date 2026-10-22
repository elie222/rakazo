import { expect, it } from "vitest";
import {
  accountSecuritySchema,
  authCapabilitiesSchema,
  legacyAuthCapabilitiesSchema,
} from "./auth.js";

it("requires explicit password and SSO capabilities", () => {
  expect(authCapabilitiesSchema.safeParse({ passwordReset: false, resetUrl: null }).success).toBe(
    false,
  );
  expect(
    authCapabilitiesSchema.parse({
      passwordAuth: false,
      passwordReset: false,
      resetUrl: null,
      sso: { name: "SSO", availability: "checking" },
    }).passwordAuth,
  ).toBe(false);
});

it("treats email code sign-in as an optional boolean capability", () => {
  const base = { passwordAuth: true, passwordReset: true, resetUrl: null, sso: null };
  expect(authCapabilitiesSchema.parse(base).emailCode).toBeUndefined();
  expect(authCapabilitiesSchema.parse({ ...base, emailCode: true }).emailCode).toBe(true);
  expect(authCapabilitiesSchema.safeParse({ ...base, emailCode: "true" }).success).toBe(false);
});

it("only accepts complete legacy capabilities without partial SSO fields", () => {
  expect(
    legacyAuthCapabilitiesSchema.parse({ passwordReset: false, resetUrl: null, billing: true }),
  ).toEqual({ passwordAuth: true, sso: null, passwordReset: false, resetUrl: null, billing: true });
  for (const value of [
    {},
    { passwordReset: false },
    { passwordReset: false, resetUrl: null, passwordAuth: false },
    { passwordReset: false, resetUrl: null, sso: null },
    { passwordReset: "false", resetUrl: null },
  ]) {
    expect(legacyAuthCapabilitiesSchema.safeParse(value).success).toBe(false);
  }
});

it("accepts older account security and explicit password-change policy", () => {
  const security = {
    hasPassword: true,
    freshOidcAuth: false,
    ssoLinked: false,
    emailDeletion: true,
    sso: null,
  };
  expect(accountSecuritySchema.parse(security).passwordChangeEnabled).not.toBe(false);
  expect(
    accountSecuritySchema.parse({ ...security, passwordChangeEnabled: false })
      .passwordChangeEnabled,
  ).toBe(false);
  expect(
    accountSecuritySchema.safeParse({ ...security, passwordChangeEnabled: "false" }).success,
  ).toBe(false);
});
