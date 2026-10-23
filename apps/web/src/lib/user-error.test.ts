import { MODEL_IMAGE_INPUT_ERROR } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { authErrorText, errorText } from "./user-error";

describe("authErrorText", () => {
  it("maps PASSWORD_AUTH_DISABLED before the server message", () => {
    expect(
      authErrorText({ code: "PASSWORD_AUTH_DISABLED", message: "Server message" }, "Fallback"),
    ).toBe("Password sign-in is turned off on this server");
  });

  it("maps email code failures", () => {
    expect(authErrorText({ code: "INVALID_OTP", message: "Invalid OTP" }, "Fallback")).toBe(
      "Invalid code",
    );
    for (const code of ["OTP_EXPIRED", "TOO_MANY_ATTEMPTS"]) {
      expect(authErrorText({ code, message: "Server message" }, "Fallback")).toBe(
        "Request a new code",
      );
    }
  });

  it("keeps messages from older servers", () => {
    expect(authErrorText({ message: "Registration is closed" }, "Fallback")).toBe(
      "Registration is closed",
    );
  });
});

it("recognizes image compatibility errors from old clients and new servers", () => {
  expect(errorText(new Error(MODEL_IMAGE_INPUT_ERROR))).toBe(MODEL_IMAGE_INPUT_ERROR);
  expect(errorText(`  ${MODEL_IMAGE_INPUT_ERROR}  `)).toBe(MODEL_IMAGE_INPUT_ERROR);
});
