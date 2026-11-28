import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_EXPORT_TOKEN_PREFIX,
  readAccountExportToken,
  spendAccountExportToken,
} from "./account-export-token.js";

describe("readAccountExportToken", () => {
  it("reads the link without spending it", async () => {
    const findVerificationValue = vi.fn(async () => ({
      value: "user-1",
      expiresAt: new Date(Date.now() + 30_000),
    }));
    await expect(readAccountExportToken({ findVerificationValue }, "abc")).resolves.toBe("user-1");
    expect(findVerificationValue).toHaveBeenCalledWith(`${ACCOUNT_EXPORT_TOKEN_PREFIX}abc`);
  });

  it("refuses a link that has expired", async () => {
    const findVerificationValue = vi.fn(async () => ({
      value: "user-1",
      expiresAt: new Date(Date.now() - 1_000),
    }));
    await expect(readAccountExportToken({ findVerificationValue }, "abc")).resolves.toBeNull();
  });

  it("refuses an empty token without a lookup", async () => {
    const findVerificationValue = vi.fn();
    await expect(readAccountExportToken({ findVerificationValue }, "")).resolves.toBeNull();
    expect(findVerificationValue).not.toHaveBeenCalled();
  });
});

describe("spendAccountExportToken", () => {
  it("spends a link a slow archive outlived, because the read already checked it", async () => {
    const consumeVerificationValue = vi.fn(async () => ({
      value: "user-1",
      expiresAt: new Date(Date.now() - 1_000),
    }));
    await expect(spendAccountExportToken({ consumeVerificationValue }, "abc")).resolves.toBe(
      "user-1",
    );
    expect(consumeVerificationValue).toHaveBeenCalledWith(`${ACCOUNT_EXPORT_TOKEN_PREFIX}abc`);
  });
});
