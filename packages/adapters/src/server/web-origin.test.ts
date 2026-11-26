import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { describe, expect, it } from "vitest";
import { absoluteHttpOrigin, webOriginFromEnv } from "./server-foundation.js";

describe("web origin", () => {
  it("drops trailing slashes and falls back to the local web client", () => {
    expect(webOriginFromEnv({ WEB_ORIGIN: " https://app.example.test// " })).toBe(
      "https://app.example.test",
    );
    expect(webOriginFromEnv({})).toBe("http://127.0.0.1:5173");
  });

  it("refuses a value that is not an absolute http(s) URL", () => {
    expect(() => webOriginFromEnv({ WEB_ORIGIN: "ftp://app.example.test" })).toThrow(
      "WEB_ORIGIN must be an absolute http(s) URL",
    );
    expect(() => webOriginFromEnv({ WEB_ORIGIN: "/".repeat(10) })).toThrow(
      "WEB_ORIGIN must be an absolute http(s) URL",
    );
  });

  it("strips a long run of slashes in linear time", () => {
    const value = `https://app.example.test${"/".repeat(100_000)}x${"/".repeat(100_000)}`;
    expectLinearTime(() => absoluteHttpOrigin(value, "http://127.0.0.1:5173", "WEB_ORIGIN"));
  });
});
