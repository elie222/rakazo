import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BACKUP_PASSWORD_MIN_LENGTH,
  canSendBackupPassword,
  isBackupPasswordBreached,
  validateBackupPassword,
} from "./backup-password";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("crypto", webcrypto);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

it("rejects short passwords and mismatched confirmation", () => {
  expect(validateBackupPassword("short", "short")).toBe("too-short");
  expect(validateBackupPassword("a".repeat(BACKUP_PASSWORD_MIN_LENGTH - 1), "a".repeat(11))).toBe(
    "too-short",
  );
  expect(validateBackupPassword("abcdefghijkl", "abcdefghijkm")).toBe("mismatch");
  expect(validateBackupPassword("abcdefghijkl", "abcdefghijkl")).toBeNull();
});

it("flags a breached password from the range response", async () => {
  const password = "correct horse battery staple";
  const hash = createHash("sha1").update(password).digest("hex").toUpperCase();
  fetchMock.mockResolvedValue(new Response(`00AABBCC:2\n${hash.slice(5)}:7\n`, { status: 200 }));

  await expect(isBackupPasswordBreached(password)).resolves.toBe(true);
  expect(fetchMock).toHaveBeenCalledWith(
    `https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`,
    expect.objectContaining({ headers: { "Add-Padding": "true" } }),
  );
});

it("passes a password absent from the range response", async () => {
  fetchMock.mockResolvedValue(new Response("00AABBCC:2\n", { status: 200 }));

  await expect(isBackupPasswordBreached("a fresh password 123")).resolves.toBe(false);
});

it("fails open when the breach lookup is unreachable", async () => {
  fetchMock.mockRejectedValue(new Error("offline"));

  await expect(isBackupPasswordBreached("abcdefghijkl")).resolves.toBe(false);
});

it("only sends the backup password over HTTPS or to loopback", () => {
  expect(canSendBackupPassword({ protocol: "https:", hostname: "rakazo.example" })).toBe(true);
  expect(canSendBackupPassword({ protocol: "http:", hostname: "rakazo.example" })).toBe(false);
  expect(canSendBackupPassword({ protocol: "http:", hostname: "localhost" })).toBe(true);
  expect(canSendBackupPassword({ protocol: "http:", hostname: "127.0.0.1" })).toBe(true);
  expect(canSendBackupPassword({ protocol: "http:", hostname: "[::1]" })).toBe(true);
});
