import type { AccountSecurity } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { IdentityConfirmationDeps } from "./identity-confirmation";
import { confirmIdentityOnDevice, NEW_CODE } from "./identity-confirmation";

const security = (overrides: Partial<AccountSecurity> = {}): AccountSecurity => ({
  hasPassword: true,
  passwordChangeEnabled: true,
  freshOidcAuth: false,
  ssoLinked: false,
  emailDeletion: true,
  sso: null,
  ...overrides,
});

function deps(account: AccountSecurity, overrides: Partial<IdentityConfirmationDeps> = {}) {
  return {
    fetchAccountSecurity: vi.fn(async () => account),
    confirmIdentity: vi.fn(async () => undefined),
    requestIdentityCode: vi.fn(async () => undefined),
    reauthenticate: vi.fn(async () => true),
    choose: vi.fn(async () => null),
    ask: vi.fn(async () => null),
    errorText: (error: unknown) => (error as Error).message,
    ...overrides,
  } satisfies IdentityConfirmationDeps;
}

describe("confirmIdentityOnDevice", () => {
  it("asks a password account for its password, never a code", async () => {
    const d = deps(security(), { ask: vi.fn(async () => " pass value ") });
    await expect(confirmIdentityOnDevice(d)).resolves.toBe(true);
    expect(d.ask).toHaveBeenCalledWith("password", null);
    expect(d.confirmIdentity).toHaveBeenCalledWith({ password: " pass value " });
    expect(d.choose).not.toHaveBeenCalled();
    expect(d.requestIdentityCode).not.toHaveBeenCalled();
  });

  it("asks again with the server's error after a wrong password", async () => {
    const d = deps(security(), {
      ask: vi
        .fn<IdentityConfirmationDeps["ask"]>()
        .mockResolvedValueOnce("wrong")
        .mockResolvedValueOnce("right"),
      confirmIdentity: vi
        .fn<IdentityConfirmationDeps["confirmIdentity"]>()
        .mockRejectedValueOnce(new Error("Invalid password"))
        .mockResolvedValueOnce(undefined),
    });
    await expect(confirmIdentityOnDevice(d)).resolves.toBe(true);
    expect(d.ask).toHaveBeenLastCalledWith("password", "Invalid password");
    expect(d.confirmIdentity).toHaveBeenLastCalledWith({ password: "right" });
  });

  it("stops when the prompt is dismissed", async () => {
    const d = deps(security());
    await expect(confirmIdentityOnDevice(d)).resolves.toBe(false);
    expect(d.confirmIdentity).not.toHaveBeenCalled();
  });

  it("emails a code to an account without a password", async () => {
    const d = deps(security({ hasPassword: false }), {
      choose: vi.fn(async () => "email" as const),
      ask: vi.fn(async () => " 123456 "),
    });
    await expect(confirmIdentityOnDevice(d)).resolves.toBe(true);
    expect(d.choose).toHaveBeenCalledWith(["email"]);
    expect(d.requestIdentityCode).toHaveBeenCalledTimes(1);
    expect(d.ask).toHaveBeenCalledWith("code", null);
    expect(d.confirmIdentity).toHaveBeenCalledWith({ code: "123456" });
  });

  it("emails a new code without leaving the prompt", async () => {
    const d = deps(security({ hasPassword: false }), {
      choose: vi.fn(async () => "email" as const),
      ask: vi
        .fn<IdentityConfirmationDeps["ask"]>()
        .mockResolvedValueOnce("000000")
        .mockResolvedValueOnce(NEW_CODE)
        .mockResolvedValueOnce("123456"),
      confirmIdentity: vi
        .fn<IdentityConfirmationDeps["confirmIdentity"]>()
        .mockRejectedValueOnce(new Error("Request a new code"))
        .mockResolvedValueOnce(undefined),
    });
    await expect(confirmIdentityOnDevice(d)).resolves.toBe(true);
    expect(d.requestIdentityCode).toHaveBeenCalledTimes(2);
    expect(d.ask).toHaveBeenNthCalledWith(2, "code", "Request a new code");
    expect(d.ask).toHaveBeenNthCalledWith(3, "code", null);
    expect(d.confirmIdentity).toHaveBeenLastCalledWith({ code: "123456" });
  });

  it("offers a fresh SSO sign-in to a linked account", async () => {
    const d = deps(security({ hasPassword: false, sso: { name: "SSO" }, ssoLinked: true }), {
      choose: vi.fn(async () => "sso" as const),
    });
    await expect(confirmIdentityOnDevice(d)).resolves.toBe(true);
    expect(d.choose).toHaveBeenCalledWith(["sso", "email"]);
    expect(d.reauthenticate).toHaveBeenCalledTimes(1);
    expect(d.confirmIdentity).not.toHaveBeenCalled();
  });

  it("does not offer SSO to an account that is not linked", async () => {
    const d = deps(security({ hasPassword: false, sso: { name: "SSO" }, emailDeletion: false }));
    await expect(confirmIdentityOnDevice(d)).rejects.toThrow();
    expect(d.choose).not.toHaveBeenCalled();
  });
});
