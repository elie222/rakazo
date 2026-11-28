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

  it("resolves the secret matcher once per payload instead of once per leaf", () => {
    const raw = ["secret-alpha-0001", "secret-beta-0002", "secret-gamma-0003"];
    let indexZeroReads = 0;
    const secrets = new Proxy(raw, {
      get(target, prop, receiver) {
        if (prop === "0") indexZeroReads += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const payload = {
      items: Array.from({ length: 40 }, (_, index) => ({
        id: `item-${index}`,
        label: index === 15 ? `contains ${raw[1]} inside` : `Element description ${index}`,
        href: `https://example.test/items/${index}`,
        active: index % 2 === 0,
      })),
    };

    // Warm the WeakMap entry, then verify a multi-leaf payload validates the secrets array once.
    redactConnectorPayload({ warm: raw[0] }, secrets);
    indexZeroReads = 0;

    const redacted = redactConnectorPayload(payload, secrets) as {
      items: Array<{ label: string }>;
    };
    expect(redacted.items[15]?.label).toBe("contains [redacted] inside");
    expect(indexZeroReads).toBe(1);
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
