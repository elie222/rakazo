import { afterEach, describe, expect, it } from "vitest";
import { activateUiLocale } from "./i18n";
import { authErrorText, loadFailureKind } from "./user-error";

const withStatus = (status: number) =>
  Object.defineProperty(new Error("Something went wrong. Try again."), "status", { value: status });

describe("loadFailureKind", () => {
  it("names the cause when the error carries one", () => {
    expect(loadFailureKind(new TypeError("Network request failed"))).toBe("offline");
    expect(loadFailureKind(withStatus(503))).toBe("offline");
    expect(loadFailureKind(withStatus(401))).toBe("session");
    expect(loadFailureKind(withStatus(500))).toBe("server");
  });

  it("leaves other failures to their message", () => {
    expect(loadFailureKind(withStatus(400))).toBe("other");
    expect(loadFailureKind(new Error("Could not save the default space"))).toBe("other");
  });
});

describe("authErrorText", () => {
  afterEach(() => activateUiLocale("en"));

  it("uses translated copy instead of the English server message", () => {
    activateUiLocale("de");
    expect(
      authErrorText({ code: "REGISTRATION_CLOSED", message: "Registration is closed" }, "Fallback"),
    ).toBe("Registrierung ist geschlossen");
    expect(
      authErrorText(
        { code: "EMAIL_NOT_ALLOWED", message: "Email is not allowed to register" },
        "Fallback",
      ),
    ).toBe("Diese E-Mail-Adresse ist nicht zur Registrierung zugelassen");
    expect(
      authErrorText(
        { code: "EMAIL_VERIFICATION_REQUIRED", message: "Email verification required" },
        "Fallback",
      ),
    ).toBe("E-Mail-Verifizierung erforderlich");
    expect(
      authErrorText(
        { code: "PASSWORD_AUTH_DISABLED", message: "Password authentication is disabled" },
        "Fallback",
      ),
    ).toBe("Die Anmeldung mit Passwort ist auf diesem Server deaktiviert");
  });
});
