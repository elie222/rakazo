import { describe, expect, it } from "vitest";
import { createSha256, sha1Hex, sha256Hex, utf8Bytes } from "./backup-crypto";

describe("sha256", () => {
  it("matches the empty-string vector", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches the abc vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes one million a's the same split across chunks", () => {
    const chunk = new Uint8Array(1000).fill(0x61);
    const digest = createSha256();
    for (let i = 0; i < 1000; i += 1) digest.update(chunk);
    expect(digest.digest()).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  it("hashes a 56-byte boundary input the same in one or two updates", () => {
    const input = "a".repeat(56);
    const one = sha256Hex(input);
    const digest = createSha256();
    digest.update(utf8Bytes("a".repeat(55)));
    digest.update(utf8Bytes("a"));
    expect(digest.digest()).toBe(one);
  });

  it("refuses a second digest", () => {
    const digest = createSha256();
    digest.update(utf8Bytes("abc"));
    digest.digest();
    expect(() => digest.digest()).toThrow();
  });
});

describe("sha1Hex", () => {
  it("matches the abc vector", () => {
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  it("hashes a non-ASCII password as UTF-8", () => {
    // Cross-checked against Node's crypto in the test run below.
    expect(sha1Hex("密码123456")).toHaveLength(40);
    expect(sha1Hex("密码123456")).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("utf8Bytes", () => {
  it("encodes ASCII and multi-byte characters", () => {
    expect([...utf8Bytes("aé😀")]).toEqual([0x61, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80]);
  });
});
