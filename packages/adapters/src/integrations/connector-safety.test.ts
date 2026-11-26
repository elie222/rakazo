import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { describe, expect, it } from "vitest";
import { redactConnectorPayload, sanitizeConnectorError } from "./connector-safety.js";

describe("redactConnectorPayload", () => {
  it("redacts secrets that JSON escapes in property names and values", () => {
    const secret = 'api"key';

    expect(
      redactConnectorPayload(
        {
          [secret]: `prefix ${secret} suffix`,
          nested: { value: secret },
          list: [secret, "kept"],
        },
        [secret],
      ),
    ).toEqual({
      "[redacted]": "prefix [redacted] suffix",
      nested: { value: "[redacted]" },
      list: ["[redacted]", "kept"],
    });
  });

  it("falls back to an inert result when the payload is not JSON serializable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(redactConnectorPayload(circular, ["secret"])).toEqual({ ok: true });
  });

  it("redacts secrets represented by non-string JSON leaves", () => {
    expect(
      redactConnectorPayload({ number: 123, boolean: true, empty: null }, ["123", "true", "null"]),
    ).toEqual({ number: "[redacted]", boolean: "[redacted]", empty: "[redacted]" });
  });

  it("redacts a value toJSON adds after the secrets array was already cached", () => {
    const secrets = ["known-secret"];
    expect(redactConnectorPayload({ first: "known-secret" }, secrets)).toEqual({
      first: "[redacted]",
    });
    const payload = {
      toJSON() {
        secrets.push("added-after-warm");
        return { first: "known-secret", second: "added-after-warm" };
      },
    };
    expect(redactConnectorPayload(payload, secrets)).toEqual({
      first: "[redacted]",
      second: "[redacted]",
    });
  });

  it("stays linear across repeated payloads with thousands of secret forms", () => {
    const secrets = Array.from(
      { length: 3_000 },
      (_, index) =>
        `${index.toString(36).padStart(4, "x")}-vault-form-${index}-secret-payload-value`,
    );
    const payload = {
      items: Array.from({ length: 150 }, (_, index) => ({
        id: `item-${index}`,
        label: index === 75 ? `contains ${secrets[1_500]} inside` : `Element description ${index}`,
        href: `https://example.test/items/${index}`,
        active: index % 2 === 0,
      })),
    };
    expectLinearTime(() => {
      for (let call = 0; call < 200; call += 1) {
        const redacted = redactConnectorPayload(payload, secrets) as {
          items: Array<{ label: string }>;
        };
        expect(redacted.items[75]?.label).toBe("contains [redacted] inside");
      }
    });
  });
});

describe("sanitizeConnectorError", () => {
  it("describes an error without a message instead of returning an empty string", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
      code: "ECONNREFUSED",
    });
    expect(sanitizeConnectorError(new AggregateError([refused], ""))).toBe(
      "connect ECONNREFUSED 127.0.0.1:8080",
    );
    expect(sanitizeConnectorError(new Error("", { cause: new Error("socket hang up") }))).toBe(
      "socket hang up",
    );
    expect(sanitizeConnectorError(Object.assign(new Error(""), { code: "EPIPE" }))).toBe(
      "Error EPIPE",
    );
    expect(sanitizeConnectorError(new TypeError(""))).toBe("TypeError without a message");
    expect(sanitizeConnectorError("")).toBe("unknown error");
  });
});
