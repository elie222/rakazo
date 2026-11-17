import { describe, expect, it } from "vitest";
import { sanitizeModelConnectionError } from "./model-connection-error.js";

const S = "EXAMPLE1placeholder2VALUE3";

describe("sanitizeModelConnectionError", () => {
  it.each([
    ["an upper-case prefixed name", `EXAMPLE_API_KEY=${S}`, "EXAMPLE_API_KEY=•••"],
    ["a mixed-case prefixed name", `MY_api_key="${S}"`, 'MY_api_key="•••"'],
    ["a camel-case prefixed name", `exampleApiKey: ${S}`, "exampleApiKey: •••"],
  ])("redacts the value of %s", (_label, raw, cleaned) => {
    expect(sanitizeModelConnectionError(raw)).toBe(cleaned);
  });

  it.each([
    ["Invalid API key", `Invalid API key: ${S}`, "Invalid API key: •••"],
    [
      "Incorrect API key provided",
      `Incorrect API key provided: ${S}. You can find your API key in settings.`,
      "Incorrect API key provided: •••. You can find your API key in settings.",
    ],
  ])("redacts the key after the two-word wording %s", (_label, raw, cleaned) => {
    expect(sanitizeModelConnectionError(raw)).toBe(cleaned);
  });

  it.each([
    ["a Basic authorization header", `Authorization: Basic ${S}`, "Authorization: •••"],
    ["an authorization header without a scheme", `Authorization: ${S}`, "Authorization: •••"],
    ["an unknown authorization scheme", `Authorization: Custom ${S}`, "Authorization: •••"],
    ["a token", `token=${S}`, "token=•••"],
    ["a password", `password=${S}`, "password=•••"],
    ["a secret", `secret: ${S}`, "secret: •••"],
    ["an API secret", `api_secret=${S}`, "api_secret=•••"],
    ["a plural key name", `api_keys=${S}`, "api_keys=•••"],
    [
      "a key query parameter",
      `GET https://models.example.com/v1/models?key=${S}&limit=10 failed`,
      "GET https://models.example.com/v1/models?key=•••&limit=10 failed",
    ],
    [
      "an access token query parameter",
      `https://models.example.com/v1/models?limit=10&access_token=${S}#models`,
      "https://models.example.com/v1/models?limit=10&access_token=•••#models",
    ],
    [
      "a password in a URL",
      `fetch https://user:${S}@models.example.com/v1 failed`,
      "fetch https://•••@models.example.com/v1 failed",
    ],
    [
      "a token in a URL without a user name",
      `https://${S}@models.example.com/v1`,
      "https://•••@models.example.com/v1",
    ],
  ])("redacts %s", (_label, raw, cleaned) => {
    expect(sanitizeModelConnectionError(raw)).toBe(cleaned);
  });

  it.each([
    ["an unrecognised scheme", `Authorization: LongSchemeX ${S}`, "Authorization: •••"],
    ["a scheme with digits", `authorization=AWS4-HMAC-SHA256 ${S}`, "authorization=•••"],
    [
      "a credential in several parts",
      `Proxy-Authorization: Digest username="user", response="${S}"`,
      "Proxy-Authorization: •••",
    ],
    [
      "a quoted value",
      `{"authorization": "Custom2 ${S}, signature=${S}", "code": 401}`,
      '{"authorization": "•••", "code": 401}',
    ],
    [
      "only its own line",
      `Authorization: Custom2 ${S} was rejected.\nTry again.`,
      "Authorization: •••.\nTry again.",
    ],
  ])("hides the whole value of an Authorization header with %s", (_label, raw, cleaned) => {
    expect(sanitizeModelConnectionError(raw)).toBe(cleaned);
  });

  it.each([
    ["an object", `api_key={"value":"${S}"} rejected`, "api_key=••• rejected"],
    ["an array", `tokens=["${S}","${S}"], retry`, "tokens=•••, retry"],
    [
      "an object in a JSON body",
      `{"api_key": {"value": "${S}", "note": "a } b"}, "code": 401}`,
      '{"api_key": •••, "code": 401}',
    ],
    [
      "an object in escaped JSON",
      `{\\"api_key\\":{\\"value\\":\\"${S}\\"},\\"code\\":401}`,
      '{\\"api_key\\":•••,\\"code\\":401}',
    ],
    [
      "an object over several lines",
      `"client_secret": {\n  "value": "${S}"\n}\nTry again.`,
      '"client_secret": •••\nTry again.',
    ],
    [
      "an object that never closes",
      `api_key={"value":"${S}" ${S}\nTry again.`,
      "api_key=•••\nTry again.",
    ],
    ["an unquoted value that opens with a bracket", `api_key=[ab]${S} rest`, "api_key=••• rest"],
  ])("hides a credential that is %s", (_label, raw, cleaned) => {
    expect(sanitizeModelConnectionError(raw)).toBe(cleaned);
  });

  it("redacts a credential object whole, the fields beside a named one included", () => {
    expect(
      sanitizeModelConnectionError('bad api_key={"token":"AAAA1111","value":"BBBB2222"} sent'),
    ).toBe("bad api_key=••• sent");
  });

  it("redacts a key sent as the user name of a URL, with or without a password", () => {
    expect(sanitizeModelConnectionError(`fetch https://${S}:@models.example.com/v1 failed`)).toBe(
      "fetch https://•••@models.example.com/v1 failed",
    );
    expect(sanitizeModelConnectionError(`fetch https://${S}:x@models.example.com/v1 failed`)).toBe(
      "fetch https://•••@models.example.com/v1 failed",
    );
  });

  it("redacts a short token after a scheme in a credential field, but not a plain word", () => {
    expect(sanitizeModelConnectionError("rejected token=Bearer abc1 for this call")).toBe(
      "rejected token=••• for this call",
    );
    expect(sanitizeModelConnectionError("rejected token=Bearer missing")).toBe(
      "rejected token=••• missing",
    );
  });

  it("redacts the value of an indexed field", () => {
    expect(sanitizeModelConnectionError("bad api_keys[0]=EXAMPLE1placeholder2VALUE3 sent")).toBe(
      "bad api_keys[0]=••• sent",
    );
  });

  it("redacts a value inside escaped JSON", () => {
    expect(sanitizeModelConnectionError(`{\\"api_key\\": \\"${S}\\", \\"code\\": 401}`)).toBe(
      '{\\"api_key\\": \\"•••\\", \\"code\\": 401}',
    );
  });

  it.each([
    ["a bearer token with a pipe", `Bearer 12|${S}`, "Bearer •••"],
    ["a bearer token with a colon", `Bearer 12:${S}`, "Bearer •••"],
    ["a quoted bearer token", `Bearer "${S}"`, 'Bearer "•••"'],
    ["a bare value with a comma", `api-key: ${S},${S}`, "api-key: •••"],
    ["a quoted value with an escaped quote", `{"api_key": "ab\\"${S}"}`, '{"api_key": "•••"}'],
    ["a quoted value whose closing quote was cut off", `api_key="${S} ${S}`, 'api_key="•••'],
    ["a backticked value with a space", `api_key=\`${S} ${S}\` rest`, "api_key=`•••` rest"],
    ["a bare key with a dot", `sk-${S}.${S}`, "•••"],
    ["a bare key before a full stop", `Rejected sk-${S}. Try again.`, "Rejected •••. Try again."],
  ])("leaves no part of %s", (_label, raw, cleaned) => {
    expect(sanitizeModelConnectionError(raw)).toBe(cleaned);
  });

  it.each([
    [
      "a quoted value after another credential word",
      `Invalid credentials: api_key = "${S} ${S}" rejected`,
      'Invalid credentials: api_key = "•••" rejected',
    ],
    [
      "a token after a scheme after another credential word",
      `credentials rejected: authorization=Token ${S} by server`,
      "credentials rejected: authorization=•••",
    ],
    [
      "a quoted value after an unquoted one",
      `token=${S},password="${S} ${S}" rejected`,
      'token=•••,password="•••" rejected',
    ],
    [
      "a JSON body after a credential word",
      `Invalid credentials: {"error":"denied","api_key":"${S} ${S}","code":401}`,
      'Invalid credentials: {"error":"denied","api_key":"•••","code":401}',
    ],
    [
      "a value whose quoted name follows a credential word",
      `credentials: \\"api_key\\"=\`${S} ${S}\` rejected`,
      'credentials: \\"api_key\\"=`•••` rejected',
    ],
  ])("hides %s", (_label, raw, cleaned) => {
    expect(sanitizeModelConnectionError(raw)).toBe(cleaned);
  });

  it("stays fast on long text built to make a pattern rescan it", () => {
    const length = 200_000;
    for (const unit of [
      "a",
      "a-",
      "token",
      "token=",
      'token="',
      '"a":',
      "token ",
      "://",
      "sk-",
      "Bearer ",
      "\\",
      " \t",
      "api key provided ",
      "token=a,",
      "token=[",
      "token=[\n",
      'token={"a":"',
      "Authorization: Custom a1 ",
      "Authorization: -",
      "Authorization: abc ",
      'api_key={"a":"x"} ',
      '"token":{',
      'credentials: "token"=',
      "?key=",
      "authorization=Token ",
      '"token":',
    ]) {
      const text = unit.repeat(Math.ceil(length / unit.length));
      const cleaned = sanitizeModelConnectionError(text);
      expect(sanitizeModelConnectionError(cleaned)).toBe(cleaned);
    }
  });

  it.each([
    "bearer of bad news",
    "Bearer authentication is required.",
    "The token expired. Sign in again.",
    "API key was rejected by the provider.",
    "Could not verify the API key. Try again.",
    "That doesn't look like an API key. Paste only the key.",
    "Model server returned 401. You can still Connect with an explicit model id.",
    "Could not reach the model server. Check that it's running.",
    '401: {"message":"Invalid API key"}',
    "invalid_api_key: Incorrect API key provided",
    "Authorization: Bearer token is missing (code 401).",
    '{"error":{"message":"missing authorization: required","type":"invalid_request_error"}}',
    '{"error": "authorization: invalid credentials", "code": 401}',
    'provider API error (400): 400 "Incorrect API key provided."',
  ])("keeps prose that carries no credential: %j", (message) => {
    expect(sanitizeModelConnectionError(message)).toBe(message);
  });

  it.each([
    ["a JSON error body", 'Invalid {"api_key": "EXAMPLE_PLACEHOLDER"}', "EXAMPLE_PLACEHOLDER"],
    [
      "a camel-case key with spaces around =",
      "apiKey = EXAMPLE_PLACEHOLDER",
      "EXAMPLE_PLACEHOLDER",
    ],
    ["a bearer token with base64 characters", "Bearer EXAMPLE+PLACE/HOLDER==", "PLACE/HOLDER"],
    ["a single-quoted value", "api-key: 'EXAMPLE_PLACEHOLDER'", "EXAMPLE_PLACEHOLDER"],
    ["a quoted value with a space", '{"api_key": "EXAMPLE PLACEHOLDER"}', "PLACEHOLDER"],
    [
      "a quoted value with a comma and brace",
      'api_key: "EX,AMPLE}PLACEHOLDER" rest',
      "PLACEHOLDER",
    ],
    ["a single-quoted value with a space", "api_key='EXAMPLE PLACEHOLDER'", "PLACEHOLDER"],
    ["a bare key", "Invalid sk-secretkey1234567890", "secretkey1234567890"],
  ])("redacts the whole secret in %s", (_label, raw, secret) => {
    const cleaned = sanitizeModelConnectionError(raw);
    expect(cleaned).not.toContain(secret);
    expect(cleaned).toContain("•••");
  });

  it("keeps the text around a redacted JSON value", () => {
    expect(sanitizeModelConnectionError('{"api_key": "EXAMPLE_PLACEHOLDER", "code": 401}')).toBe(
      '{"api_key": "•••", "code": 401}',
    );
  });

  describe("with the credentials the connection was tested with", () => {
    it.each([
      ["with no credential wording around it", `denied for ${S} on this server`],
      ["inside a longer word", `x${S}y`],
      [
        "in a rejected header",
        `Headers.append: "Bearer 12é${S}" is an invalid header value.`,
        `12é${S}`,
      ],
      ["URL-encoded", `GET /v1/models?k=${encodeURIComponent(`a/b+${S}=`)}`, `a/b+${S}=`],
      ["form-encoded", `body k=a+b%2F${S}`, `a b/${S}`],
      ["JSON-escaped", `{"detail":"got a\\"${S}\\\\"}`, `a"${S}\\`],
      ["URL-encoded in lower case", `GET /v1/models?k=a%2fb%2b${S}%3d`, `a/b+${S}=`],
      ["URL-encoded in mixed case", `GET /v1/models?k=a%2Fb%2b${S}%3D`, `a/b+${S}=`],
      ["JSON-escaped with escaped slashes", `{"detail":"got a\\/${S}"}`, `a/${S}`],
      ["in another letter case", `denied for ${S.toLowerCase()}`],
      ["as the token of a header value sent with its scheme", `denied for ${S}`, `Bearer ${S}`],
    ])("redacts a known value %s", (_label, raw, secret = S) => {
      const cleaned = sanitizeModelConnectionError(raw, [secret]);
      expect(cleaned).not.toContain(S);
      expect(cleaned).toContain("•••");
    });

    it("redacts every known value and ignores blank ones", () => {
      expect(
        sanitizeModelConnectionError(`sent ${S} with header-value-123456`, [
          ` ${S} `,
          undefined,
          null,
          "",
          "header-value-123456",
        ]),
      ).toBe("sent ••• with •••");
    });

    it("redacts a known value of four characters", () => {
      expect(sanitizeModelConnectionError("denied for a1b2 on this server", ["a1b2"])).toBe(
        "denied for ••• on this server",
      );
    });

    it("redacts a known value under eight characters only where it stands alone", () => {
      expect(
        sanitizeModelConnectionError("local refused: connect ECONNREFUSED localhost:11434", [
          "local",
        ]),
      ).toBe("••• refused: connect ECONNREFUSED localhost:11434");
      expect(
        sanitizeModelConnectionError("the beta flag is not true for betatesters", ["beta", "true"]),
      ).toBe("the ••• flag is not ••• for betatesters");
    });

    it("redacts a longer known value inside other text", () => {
      expect(sanitizeModelConnectionError("got xlocal-key-1y", ["local-key-1"])).toBe("got x•••y");
    });

    it("redacts a header's token by itself when it is long, even if it is all letters", () => {
      expect(
        sanitizeModelConnectionError("rejected ABCDEFGHIJKLMNOP", ["Bearer ABCDEFGHIJKLMNOP"]),
      ).toBe("rejected •••");
    });

    it("redacts a known value written with every reserved mark escaped", () => {
      expect(sanitizeModelConnectionError("rejected abcd%7Eefgh%21", ["abcd~efgh!"])).toBe(
        "rejected •••",
      );
    });

    it("keeps the second word of a two-word header value that is not a token", () => {
      expect(sanitizeModelConnectionError("desktop client rejected", ["example desktop"])).toBe(
        "desktop client rejected",
      );
    });

    it("leaves a shorter value, which would blank ordinary text", () => {
      expect(sanitizeModelConnectionError("API key x returned 401.", ["401", "key", "x"])).toBe(
        "API key x returned 401.",
      );
    });
  });
});
