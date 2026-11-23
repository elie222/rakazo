import { describe, expect, it } from "vitest";
import {
  boundedSandboxCommandTimeoutMs,
  DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS,
  MAX_SANDBOX_COMMAND_TIMEOUT_MS,
  sandboxCommandTimeoutExceedsMax,
  sandboxCommandTimeoutMs,
} from "./sandbox-command.js";

describe("sandbox command timeout", () => {
  it("uses a safe default and accepts a bounded deployment override", () => {
    expect(sandboxCommandTimeoutMs({})).toBe(DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS);
    expect(sandboxCommandTimeoutMs({ SANDBOX_COMMAND_TIMEOUT_MS: "120000" })).toBe(120_000);
    expect(sandboxCommandTimeoutMs({ SANDBOX_COMMAND_TIMEOUT_MS: "invalid" })).toBe(
      DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS,
    );
  });

  it("uses the maximum, not the default, when the override is above it", () => {
    for (const value of [String(MAX_SANDBOX_COMMAND_TIMEOUT_MS + 1), "7200000"]) {
      expect(sandboxCommandTimeoutMs({ SANDBOX_COMMAND_TIMEOUT_MS: value })).toBe(
        MAX_SANDBOX_COMMAND_TIMEOUT_MS,
      );
      expect(sandboxCommandTimeoutExceedsMax({ SANDBOX_COMMAND_TIMEOUT_MS: value })).toBe(true);
    }
    expect(
      sandboxCommandTimeoutExceedsMax({
        SANDBOX_COMMAND_TIMEOUT_MS: String(MAX_SANDBOX_COMMAND_TIMEOUT_MS),
      }),
    ).toBe(false);
  });

  it("keeps the default for unset, blank, zero, negative and non-numeric overrides", () => {
    for (const value of [undefined, "", "  ", "0", "-5", "invalid", "Infinity"]) {
      expect(sandboxCommandTimeoutMs({ SANDBOX_COMMAND_TIMEOUT_MS: value })).toBe(
        DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS,
      );
      expect(sandboxCommandTimeoutExceedsMax({ SANDBOX_COMMAND_TIMEOUT_MS: value })).toBe(false);
    }
  });

  it("honors bounded per-command timeouts and rejects invalid values", () => {
    expect(boundedSandboxCommandTimeoutMs(25, 100)).toBe(25);
    expect(boundedSandboxCommandTimeoutMs(0, 100)).toBe(100);
    expect(boundedSandboxCommandTimeoutMs(Number.NaN, 100)).toBe(100);
    expect(boundedSandboxCommandTimeoutMs(1.5, 100)).toBe(100);
    expect(boundedSandboxCommandTimeoutMs(MAX_SANDBOX_COMMAND_TIMEOUT_MS, 100)).toBe(
      MAX_SANDBOX_COMMAND_TIMEOUT_MS,
    );
    expect(boundedSandboxCommandTimeoutMs(MAX_SANDBOX_COMMAND_TIMEOUT_MS + 1, 100)).toBe(100);
    expect(boundedSandboxCommandTimeoutMs(undefined, Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS,
    );
  });
});
