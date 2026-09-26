import { describe, expect, it } from "vitest";
import { callClientNonce, callIdFromClientNonce, isCallClientNonce } from "./call-nonce.js";

describe("call client nonce", () => {
  it("round-trips the call id", () => {
    const nonce = callClientNonce("call-1");
    expect(isCallClientNonce(nonce)).toBe(true);
    expect(callIdFromClientNonce(nonce)).toBe("call-1");
  });

  it("stays unique per message within one call", () => {
    expect(callClientNonce("call-1")).not.toBe(callClientNonce("call-1"));
  });

  it("rejects a call id that would blur the nonce format", () => {
    expect(() => callClientNonce("call:1")).toThrow();
  });

  it("reads the id up to the unique suffix, not the first colon", () => {
    expect(callIdFromClientNonce("call:call:1:abc")).toBe("call:1");
    expect(callIdFromClientNonce("call:call-1")).toBeUndefined();
  });

  it("rejects plain nonces and other prefixed nonces", () => {
    for (const nonce of [null, undefined, "", "abc-123", "user-progress:run-1:0:x:y"]) {
      expect(isCallClientNonce(nonce)).toBe(false);
      expect(callIdFromClientNonce(nonce)).toBeUndefined();
    }
  });
});
