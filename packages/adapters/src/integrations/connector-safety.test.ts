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

  it("redacts JSON-escaped secrets before the 2,000-character cut without splitting surrogates", () => {
    const secret = "secret-value-99";
    const escaped = "\\u0073\\u0065cret-value-99";
    const raw = `{"note":"${"a".repeat(1_978)}${escaped} tail"}`;
    const sanitized = sanitizeConnectorError(new Error(raw), [secret]);
    expect(sanitized.length).toBeLessThanOrEqual(2_000);
    expect(sanitized).not.toContain("\\u0073");
    expect(sanitized).not.toContain("secret");
    expect(sanitized).not.toContain("value-99");
    expect(sanitized).toContain("[redacted]");

    const emojiCut = sanitizeConnectorError(new Error(`${"x".repeat(1_999)}😀tail`));
    expect(Buffer.from(emojiCut, "utf8").toString("utf8")).toBe(emojiCut);
    expect(emojiCut.length).toBe(1_999);
  });

  it("preserves valid JSON framing and sibling fields when redacting bearer tokens inside JSON strings", () => {
    const sanitized = sanitizeConnectorError(
      new Error('{"auth":"Bearer tok123","msg":"Bearer tok456\\nNext line","next":"keep"}'),
    );
    expect(JSON.parse(sanitized)).toEqual({
      auth: "Bearer [redacted]",
      msg: "Bearer [redacted]\nNext line",
      next: "keep",
    });
  });

  it("redacts secrets and bearer tokens inside undecodable quoted diagnostics and across literal quotes", () => {
    const windowsDiag = sanitizeConnectorError(
      new Error('Failed reading "C:\\Users\\bob\\secret-tok" with "C:\\Users\\Bearer tok789"'),
      ["secret-tok"],
    );
    expect(windowsDiag).toBe(
      'Failed reading "C:\\Users\\bob\\[redacted]" with "C:\\Users\\Bearer [redacted]"',
    );

    const quotedSecret = 'api"secret';
    const acrossQuotes = sanitizeConnectorError(new Error(`Invalid value ${quotedSecret} in arg`), [
      quotedSecret,
    ]);
    expect(acrossQuotes).toBe("Invalid value [redacted] in arg");

    const quotedBearer = sanitizeConnectorError(
      new Error("Authorization: Bearer \"quoted-tok-1\" and Bearer 'quoted-tok-2'"),
    );
    expect(quotedBearer).toBe("Authorization: Bearer [redacted] and Bearer [redacted]");

    const clippedQuotedBearer = sanitizeConnectorError(
      new Error("Authorization: Bearer \"clipped-tok-1\nNext: Bearer 'clipped-tok-2"),
    );
    expect(clippedQuotedBearer).toBe("Authorization: Bearer [redacted]\nNext: Bearer [redacted]");

    const semicolonSecret = "tok-part;fixture-suffix";
    expect(
      sanitizeConnectorError(new Error(`Authorization: Bearer ${semicolonSecret}`), [
        semicolonSecret,
      ]),
    ).toBe("Authorization: Bearer [redacted]");

    const colonQuoted = sanitizeConnectorError(new Error(`Error: "${quotedSecret}"`), [
      quotedSecret,
    ]);
    expect(colonQuoted).toBe('Error: "[redacted]"');

    const slashSecret = "prefix\\";
    const escapedQuoteJson = sanitizeConnectorError(
      new Error('{"safe":"prefix\\"kept","secret":"prefix\\\\"}'),
      [slashSecret],
    );
    expect(JSON.parse(escapedQuoteJson)).toEqual({
      safe: 'prefix"kept',
      secret: "[redacted]",
    });

    const labelQuotedSecret = 'fixture: "opaque-123"';
    expect(
      sanitizeConnectorError(new Error(`Rejected value ${labelQuotedSecret}`), [labelQuotedSecret]),
    ).toBe("Rejected value [redacted]");

    expect(
      sanitizeConnectorError(new Error('"s\\u00e9cret-123"\n"done"\n"s\\u00e9cret-123"'), [
        "sécret-123",
      ]),
    ).toBe('"[redacted]"\n"done"\n"[redacted]"');

    expect(
      sanitizeConnectorError(new Error('Response body: "s\\u00e9cret-123" (HTTP 400)'), [
        "sécret-123",
      ]),
    ).toBe('Response body: "[redacted]" (HTTP 400)');

    expect(sanitizeConnectorError(new Error('Authorization: Bearer\n "opaque-123"'))).toBe(
      "Authorization: Bearer [redacted]",
    );

    const jsonObjSecret = '{"mode":"opaque-123"}';
    expect(
      JSON.parse(
        sanitizeConnectorError(new Error('{"value":{"mode":"opaque-123"},"next":"ok"}'), [
          jsonObjSecret,
        ]),
      ),
    ).toEqual({ value: "[redacted]", next: "ok" });

    const jsonArraySecret = "[731428,918273]";
    expect(
      JSON.parse(
        sanitizeConnectorError(new Error('{"value":[731428,918273],"next":"ok"}'), [
          jsonArraySecret,
        ]),
      ),
    ).toEqual({ value: "[redacted]", next: "ok" });

    const escapedQuotedSecret = '\\"opaque-123\\"';
    const escapedQuotedResult = sanitizeConnectorError(
      new Error('{"message":"details: [\\"opaque-123\\"]","next":"ok"}'),
      [escapedQuotedSecret],
    );
    expect(escapedQuotedResult).not.toContain(escapedQuotedSecret);
    expect(JSON.parse(escapedQuotedResult)).toEqual({
      message: "details: [[redacted]]",
      next: "ok",
    });

    const jsonlResult = sanitizeConnectorError(
      new Error('{"value":{"mode":"opaque-123"},"next":"ok"}\n{"done":true}'),
      [jsonObjSecret],
    );
    expect(jsonlResult.split("\n").map((line) => JSON.parse(line))).toEqual([
      { value: "[redacted]", next: "ok" },
      { done: true },
    ]);

    expect(
      sanitizeConnectorError(new Error('Response body: "s\\u00e9cret-123". HTTP 400'), [
        "sécret-123",
      ]),
    ).toBe('Response body: "[redacted]". HTTP 400');

    // Clipped JSON string with escape-aligned registered secret.
    expect(
      sanitizeConnectorError(new Error('{"message":"details: [\\"opaque-123\\"]'), [
        escapedQuotedSecret,
      ]),
    ).toBe('{"message":"details: [[redacted]]');

    // Co-occurring raw-escaped secret and plain secret in the same string.
    expect(
      JSON.parse(
        sanitizeConnectorError(new Error('{"message":"\\u006fpaque-123 and other-secret"}'), [
          "\\u006fpaque-123",
          "other-secret",
        ]),
      ),
    ).toEqual({ message: "[redacted] and [redacted]" });

    // Protected line extracted from a multiline secret.
    expect(
      JSON.parse(
        sanitizeConnectorError(new Error('{"message":"opaque-1234567890"}'), [
          'heading\n"opaque-1234567890"\nfooter',
        ]),
      ),
    ).toEqual({ message: "[redacted]" });

    // Primitive JSONL record stays valid JSON when redacted.
    expect(
      sanitizeConnectorError(new Error('{"done":true}\n731428'), ["731428"])
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([{ done: true }, "[redacted]"]);
  });
});
