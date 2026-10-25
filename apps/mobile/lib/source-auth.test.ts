import { describe, expect, it } from "vitest";
import { nativeMcpSlug, sourceCredentialAuth } from "./source-auth";

describe("native custom-source authentication", () => {
  it("sends a credential in the encrypted field, not in the auth configuration", () => {
    expect(sourceCredentialAuth("bearer", "")).toEqual({ type: "bearer" });
    expect(sourceCredentialAuth("none", "")).toEqual({ type: "none" });
    expect(sourceCredentialAuth("api_key", " x-api-key ")).toEqual({
      type: "header",
      name: "x-api-key",
    });
    expect(JSON.stringify(sourceCredentialAuth("api_key", "x-api-key"))).not.toContain(
      "secret-value",
    );
  });
  it("rejects invalid names and transport headers before sending the request", () => {
    expect(() => sourceCredentialAuth("api_key", "x-key\nInjected: true")).toThrow();
    expect(() => sourceCredentialAuth("api_key", "Host")).toThrow();
    expect(() => sourceCredentialAuth("api_key", "")).toThrow();
  });
  it("produces a safe server slug independent of the display name", () => {
    expect(nativeMcpSlug(1700000000000)).toMatch(/^native-mcp-[a-z0-9]+$/);
    expect(() => nativeMcpSlug(Number.NaN)).toThrow();
  });
});
