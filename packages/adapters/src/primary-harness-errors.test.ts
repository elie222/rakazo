import { describe, expect, it } from "vitest";
import {
  claudeProviderFailure,
  codexProviderFailure,
  kimiProviderFailure,
  nativeHttpFailure,
  nativeProviderError,
} from "./primary-harness-errors.js";

describe("safe native provider errors", () => {
  it.each([
    [401, "authentication"],
    [403, "authentication"],
    [402, "quota"],
    [429, "quota"],
    [408, "network"],
    [504, "network"],
    [503, "overloaded"],
    [400, "request"],
    [404, "model"],
  ] as const)("classifies HTTP %s without inspecting provider text", (status, expected) => {
    expect(nativeHttpFailure(status)).toBe(expected);
  });
  it("classifies exact vendor codes and rejects arbitrary text", () => {
    expect(claudeProviderFailure("authentication_failed")).toBe("authentication");
    expect(claudeProviderFailure("rate_limit")).toBe("quota");
    expect(kimiProviderFailure("provider.auth_error")).toBe("authentication");
    expect(kimiProviderFailure("provider.rate_limit")).toBe("quota");
    expect(kimiProviderFailure("context.overflow")).toBe("context");
    expect(codexProviderFailure({ codexErrorInfo: "unauthorized" })).toBe("authentication");
    expect(codexProviderFailure({ codexErrorInfo: "usageLimitExceeded" })).toBe("quota");
    expect(
      codexProviderFailure({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } }),
    ).toBe("quota");
    expect(
      codexProviderFailure({
        codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: null } },
      }),
    ).toBe("network");
    for (const value of [
      undefined,
      "401",
      "invalid token SECRET",
      { message: "Unauthorized SECRET" },
    ]) {
      expect(nativeHttpFailure(value)).toBeUndefined();
      expect(claudeProviderFailure(value)).toBeUndefined();
      expect(kimiProviderFailure(value)).toBeUndefined();
      expect(codexProviderFailure(value)).toBeUndefined();
    }
  });
  it("returns actionable static explanations", () => {
    expect(nativeProviderError("Codex", "authentication").message).toContain("Reconnect");
    expect(nativeProviderError("Claude Agent", "quota").message).toContain("quota");
    expect(nativeProviderError("Kimi Code", "network").message).toContain("endpoint and network");
  });
});
