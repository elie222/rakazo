import { describe, expect, it } from "vitest";
import { secretFieldTraits } from "./secret-field-traits";

const credential = (type: string) => ({ auth: { type } });

describe("secret field AutoFill traits", () => {
  it("offers saved passwords for a password and for a website login", () => {
    const password = { textContentType: "password", autoComplete: "current-password" };
    expect(secretFieldTraits("password", undefined)).toEqual(password);
    expect(secretFieldTraits("password", credential("bearer"))).toEqual(password);
    expect(secretFieldTraits("password", credential("login"))).toEqual(password);
    expect(secretFieldTraits("otp", credential("login"))).toEqual(password);
  });

  it("offers the one-time code only for a connector code, the default purpose", () => {
    const code = { textContentType: "oneTimeCode", autoComplete: "one-time-code" };
    expect(secretFieldTraits("otp", undefined)).toEqual(code);
    expect(secretFieldTraits(undefined, undefined)).toEqual(code);
  });

  it("keeps the one-time code off a code saved for a site the bot named", () => {
    const none = { textContentType: "none", autoComplete: "off" };
    for (const type of ["bearer", "header", "basic"]) {
      expect(secretFieldTraits("otp", credential(type))).toEqual(none);
      expect(secretFieldTraits(undefined, credential(type))).toEqual(none);
    }
  });

  it("keeps AutoFill off for an API key and a command variable", () => {
    const none = { textContentType: "none", autoComplete: "off" };
    expect(secretFieldTraits("api_key", undefined)).toEqual(none);
    expect(secretFieldTraits("api_key", credential("header"))).toEqual(none);
    expect(secretFieldTraits("api_key", credential("command"))).toEqual(none);
    expect(secretFieldTraits("password", credential("command"))).toEqual(none);
    expect(secretFieldTraits("otp", credential("command"))).toEqual(none);
  });
});
