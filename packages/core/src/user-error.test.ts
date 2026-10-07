import { describe, expect, it } from "vitest";
import {
  authErrorMessage,
  credentialIssue,
  isNetworkFailure,
  isTechnicalErrorMessage,
  userErrorMessage,
} from "./user-error.js";

const copy = { fallback: "Could not load bots", offline: "Could not reach the server" };
const authCopy = {
  fallback: "Could not sign up",
  email: "Enter a valid email",
  password: "Enter a password",
};

describe("isNetworkFailure", () => {
  it("recognizes every platform's unreachable-server wording", () => {
    for (const message of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "Network request failed",
      "fetch failed",
      "fetch failed: UnexpectedException: Could not connect to the server. (at ExpoModulesCore/Promise.swift:56)",
      "The Internet connection appears to be offline.",
    ]) {
      expect(isNetworkFailure(new TypeError(message))).toBe(true);
    }
  });

  it("follows causes and socket error codes", () => {
    const refused = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
    expect(isNetworkFailure(new Error("request", { cause: refused }))).toBe(true);
  });

  it("leaves server responses and non-errors alone", () => {
    expect(isNetworkFailure(new Error("Bot not found"))).toBe(false);
    expect(isNetworkFailure("fetch failed")).toBe(false);
    expect(isNetworkFailure(null)).toBe(false);
  });
});

describe("isTechnicalErrorMessage", () => {
  it("flags validation dumps, exceptions, stack frames, JSON, status dumps, and codes", () => {
    for (const message of [
      "[body.email] Invalid email address; [body.password] Too small: expected string to have >=1 characters",
      "UnexpectedException: something",
      "TypeError: undefined is not a function",
      "Could not open (at ExpoModulesCore/Promise.swift:56)",
      '{"error":"boom"}',
      "rpc bots/list failed",
      "rpc threads/subscribe failed (502)",
      "Voice failed (500)",
      "connect ECONNREFUSED 127.0.0.1:3000",
      "VALIDATION_ERROR",
      "Response body exceeds 262144 bytes",
      "JSON Parse error: Unexpected character: <",
    ]) {
      expect(isTechnicalErrorMessage(message), message).toBe(true);
    }
  });

  it("keeps copy written for people", () => {
    for (const message of [
      "Bot not found",
      "Invalid email or password",
      "Request timed out",
      "Update your server to use AI data sharing in this mobile version.",
      "You do not have access to this space",
      "Use a longer password (at least 8 characters)",
    ]) {
      expect(isTechnicalErrorMessage(message), message).toBe(false);
    }
  });
});

describe("userErrorMessage", () => {
  it("says the server is unreachable for transport failures", () => {
    expect(userErrorMessage(new TypeError("Failed to fetch"), copy)).toBe(copy.offline);
  });

  it("passes human messages through and replaces technical ones", () => {
    expect(userErrorMessage(new Error("Bot not found"), copy)).toBe("Bot not found");
    expect(userErrorMessage(new Error("rpc bots/list failed"), copy)).toBe(copy.fallback);
    expect(userErrorMessage(new Error("  "), copy)).toBe(copy.fallback);
    expect(userErrorMessage({ message: "Bot not found" }, copy)).toBe(copy.fallback);
    expect(userErrorMessage("Bot not found", copy)).toBe("Bot not found");
  });
});

describe("credentialIssue", () => {
  it("asks for a well-formed email before a password", () => {
    expect(credentialIssue({ email: "", password: "" })).toBe("email");
    expect(credentialIssue({ email: "ada@", password: "secret" })).toBe("email");
    expect(credentialIssue({ email: "ada@example", password: "secret" })).toBe("email");
    expect(credentialIssue({ email: " ada@example.com ", password: "" })).toBe("password");
    expect(credentialIssue({ email: "ada@example.com", password: "secret" })).toBeNull();
  });

  it("skips the password when the form has none", () => {
    expect(credentialIssue({ email: "ada@example.com" })).toBeNull();
  });
});

describe("authErrorMessage", () => {
  it("maps validation issue paths to field copy", () => {
    expect(
      authErrorMessage(
        {
          code: "VALIDATION_ERROR",
          message:
            "[body.email] Invalid email address; [body.password] Too small: expected string to have >=1 characters",
        },
        authCopy,
      ),
    ).toBe(authCopy.email);
    expect(
      authErrorMessage(
        { code: "VALIDATION_ERROR", message: "[body.password] Too small" },
        authCopy,
      ),
    ).toBe(authCopy.password);
    expect(
      authErrorMessage({ code: "VALIDATION_ERROR", message: "[body.name] Too big" }, authCopy),
    ).toBe(authCopy.fallback);
  });

  it("keeps the server's own auth copy and hides anything technical", () => {
    expect(
      authErrorMessage(
        { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
        authCopy,
      ),
    ).toBe("Invalid email or password");
    expect(authErrorMessage({ message: '{"detail":"x"}' }, authCopy)).toBe(authCopy.fallback);
    expect(authErrorMessage(undefined, authCopy)).toBe(authCopy.fallback);
  });
});
