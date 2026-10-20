import { describe, expect, it } from "vitest";
import { authErrorText } from "./user-error";

describe("authErrorText", () => {
  it.each([
    ["REGISTRATION_CLOSED", "Registration is closed"],
    ["EMAIL_NOT_ALLOWED", "Email is not allowed to register"],
    ["EMAIL_VERIFICATION_REQUIRED", "Email verification required"],
    ["PASSWORD_AUTH_DISABLED", "Password sign-in is turned off on this server"],
    ["EMAIL_DELETION_UNAVAILABLE", "Could not continue"],
  ])("maps %s before the server message", (code, message) => {
    expect(authErrorText({ code, message: "Server message" }, "Fallback")).toBe(message);
  });

  it("keeps messages from older servers", () => {
    expect(authErrorText({ message: "Registration is closed" }, "Fallback")).toBe(
      "Registration is closed",
    );
  });
});
