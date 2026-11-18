import { describe, expect, it } from "vitest";
import { createSealedBoxKey, SEALED_BOX_PUBLIC_KEY, sealTo } from "./sealed-box.js";

describe("sealed box", () => {
  it("opens only with the key it was sealed to", () => {
    const key = createSealedBoxKey();
    const other = createSealedBoxKey();
    expect(key.publicKey).toMatch(SEALED_BOX_PUBLIC_KEY);
    const sealed = sealTo(key.publicKey, '{"approve":true}');
    expect(sealed).not.toContain("approve");
    expect(key.open(sealed)).toBe('{"approve":true}');
    expect(other.open(sealed)).toBeUndefined();
  });

  it("refuses an altered or malformed box", () => {
    const key = createSealedBoxKey();
    const parts = sealTo(key.publicKey, "hello").split(".");
    parts[2] = Buffer.from("jello").toString("base64url");
    expect(key.open(parts.join("."))).toBeUndefined();
    expect(key.open("not.a.box")).toBeUndefined();
    const short = sealTo(key.publicKey, "hello").split(".");
    short[3] = Buffer.from(short[3]!, "base64url").subarray(0, 4).toString("base64url");
    expect(key.open(short.join("."))).toBeUndefined();
    expect(() => sealTo("short", "x")).toThrow("Not an X25519 public key");
  });
});
