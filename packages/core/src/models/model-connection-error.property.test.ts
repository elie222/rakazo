import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sanitizeModelConnectionError } from "./model-connection-error.js";

const SEED = 42;
const LEAK_LENGTH = 6;

function survivingPart(secret: string, output: string): string | undefined {
  for (let start = 0; start + LEAK_LENGTH <= secret.length; start++) {
    const part = secret.slice(start, start + LEAK_LENGTH);
    if (output.includes(part)) return part;
  }
  return undefined;
}

const chars = (alphabet: string, minLength: number, maxLength: number) =>
  fc.string({ unit: fc.constantFrom(...alphabet), minLength, maxLength });

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALNUM = `${UPPER}${UPPER.toLowerCase()}0123456789`;
const VISIBLE_ASCII = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join("");
const without = (alphabet: string, excluded: string) =>
  [...alphabet].filter((char) => !excluded.includes(char)).join("");

const endsAlnum = (body: fc.Arbitrary<string>) =>
  fc.tuple(body, chars(ALNUM, 1, 1)).map(([head, last]) => head + last);

// A quote opens or closes a quoted value, a bracket opens an object or array, and a plain word
// after sentence-like wording is prose; an unquoted credential starts with neither and is not a
// word.
const unquoted = (alphabet: string) =>
  chars(without(alphabet, "\"'`"), 12, 40).filter(
    (value) => /\d/.test(value) && !/^[{[]/.test(value),
  );

const word = fc.constantFrom(
  "request",
  "failed",
  "with",
  "status",
  "401",
  "from",
  "the",
  "model",
  "server",
  "unauthorized",
  "invalid",
  "credentials",
);
const prose = fc.array(word, { minLength: 1, maxLength: 6 }).map((words) => words.join(" "));

/** `openEnded` values have no closing mark, so they run to the end of their line. */
type Planted = { text: string; secret: string; openEnded?: boolean };

const bareKey = fc
  .tuple(
    fc.constantFrom("sk-", "sk-test-"),
    chars(`${ALNUM}_-`, 8, 20),
    endsAlnum(chars(`${ALNUM}_.~+/=*-`, 4, 20)),
  )
  .map(([prefix, head, tail]): Planted => ({ text: prefix + head + tail, secret: head + tail }));

const schemeToken = fc
  .tuple(
    fc.constantFrom("Bearer", "bearer", "Basic", "token: Bearer", "x-auth-token=Token"),
    fc.constantFrom(" ", "  ", "\t"),
    fc.oneof(
      unquoted(`${ALNUM}_.~+/=-`),
      unquoted(VISIBLE_ASCII),
      chars(without(`${VISIBLE_ASCII} `, '"\\'), 12, 40).map((value) => `"${value}"`),
    ),
  )
  .map(
    ([scheme, gap, token]): Planted => ({
      text: `${scheme}${gap}${token}`,
      secret: token.replaceAll('"', ""),
    }),
  );

const credentialName = fc.constantFrom(
  "api_key",
  "api-key",
  "apikey",
  "apiKey",
  "API_KEY",
  "Api-Key",
  "x-api-key",
  "X-API-Key",
  "EXAMPLE_API_KEY",
  "MY_api_key",
  "exampleApiKey",
  "API key",
  "Invalid API key",
  "Incorrect API key provided",
  "api_keys",
  "api_secret",
  "client_secret",
  "access_token",
  "refreshToken",
  "x-auth-token",
  "token",
  "password",
  "DB_PASSWORD",
  "secret",
  "credential",
);
const separator = fc.constantFrom("=", ":", ": ", " = ", " : ", ":\t");

type Value = { written: string; value: string; openEnded?: boolean };
const anyValue: fc.Arbitrary<Value> = fc.oneof(
  chars(`${VISIBLE_ASCII} `, 12, 40).map((value) => ({ written: JSON.stringify(value), value })),
  chars(without(`${VISIBLE_ASCII} `, "'\\"), 12, 40).map((value) => ({
    written: `'${value}'`,
    value,
  })),
  chars(without(`${VISIBLE_ASCII} `, "`\\"), 12, 40).map((value) => ({
    written: `\`${value}\``,
    value,
  })),
  chars(`${VISIBLE_ASCII} `, 12, 40).map((value) => ({
    written: JSON.stringify(JSON.stringify(value)).slice(1, -1),
    value,
  })),
  unquoted(VISIBLE_ASCII).map((value) => ({ written: value, value })),
  fc
    .tuple(
      fc.constantFrom('"', "'", "`", '\\"'),
      chars(without(`${VISIBLE_ASCII} `, "\"'`\\"), 12, 40),
    )
    .map(([open, value]) => ({ written: open + value, value, openEnded: true })),
);
const assigned = fc
  .tuple(fc.constantFrom("", '"', "'", '\\"'), credentialName, separator, anyValue)
  .map(
    ([nameQuote, name, gap, { written, value, openEnded }]): Planted => ({
      text: `${nameQuote}${name}${nameQuote}${gap}${written}`,
      secret: value,
      openEnded,
    }),
  );

const withDigit = (alphabet: string) => chars(alphabet, 12, 40).filter((value) => /\d/.test(value));

// The whole value is the credential, under any scheme and in any number of parts: to the closing
// quote when it is quoted, else to the end of the line.
const authorizationHeader = fc
  .tuple(
    fc.constantFrom("", '"', '\\"'),
    fc.constantFrom(
      "Authorization",
      "authorization",
      "Proxy-Authorization",
      "X-Upstream-Authorization",
    ),
    separator,
    fc.constantFrom("", "Bearer ", "Basic  ", "LongSchemeX ", "AWS4-HMAC-SHA256 ", "Custom2\t"),
    fc.oneof(
      fc
        .tuple(
          unquoted(VISIBLE_ASCII),
          fc.array(withDigit(VISIBLE_ASCII), { maxLength: 2 }),
          fc.constantFrom(" ", ", "),
        )
        .map(([first, more, gap]) => ({ value: [first, ...more].join(gap), quote: "" })),
      withDigit(without(`${VISIBLE_ASCII} `, '"\\')).map((value) => ({ value, quote: '"' })),
    ),
  )
  .map(
    ([nameQuote, name, gap, scheme, { value, quote }]): Planted => ({
      text: `${nameQuote}${name}${nameQuote}${gap}${quote}${scheme}${value}${quote}`,
      secret: value,
      openEnded: !quote,
    }),
  );

// Written as a field, a credential that is an object or array is hidden to its closing bracket,
// whatever its strings hold; cut off, it hides the rest of its line.
const nestedCredential = fc
  .tuple(
    fc.oneof(
      fc.tuple(
        fc.constantFrom("api_key", "apiKey", "x-api-key", "client_secret", "tokens", "password"),
        fc.constantFrom("=", " = ", ":"),
      ),
      fc.tuple(
        fc.constantFrom('"api_key"', '"access_token"', '"credentials"', "'secret'"),
        fc.constantFrom(":", ": ", "="),
      ),
    ),
    chars(`${VISIBLE_ASCII} `, 12, 40),
    fc.constantFrom<(value: string) => string>(
      (value) => `{"value":${value}}`,
      (value) => `[${value}]`,
      (value) => `{"a": {"b": ${value}}, "c": [1, 2]}`,
      (value) => `{"note":"a } ] b","value":${value}}`,
      (value) => `[{"id":1},\n  ${value}\n]`,
    ),
    fc.constantFrom("plain", "escaped", "cut off"),
  )
  .map(([[name, gap], value, wrap, form]): Planted => {
    const nested = wrap(JSON.stringify(value));
    if (form === "plain") return { text: `${name}${gap}${nested}`, secret: value };
    if (form === "escaped") {
      return { text: `${name}${gap}${JSON.stringify(nested).slice(1, -1)}`, secret: value };
    }
    const cutOff = value.replace(/["\\]/g, "x");
    return { text: `${name}${gap}{"value":"${cutOff}`, secret: cutOff, openEnded: true };
  });

const jsonBody = fc
  .tuple(
    fc.constantFrom("api_key", "apiKey", "api-key", "apikey", "token", "client_secret", "password"),
    fc.constantFrom(":", ": "),
    chars(`${VISIBLE_ASCII} `, 12, 40),
    fc.boolean(),
  )
  .map(([key, gap, value, escaped]): Planted => {
    const body = `{"error":"denied","${key}"${gap}${JSON.stringify(value)},"code":401}`;
    return { text: escaped ? JSON.stringify(body).slice(1, -1) : body, secret: value };
  });

const urlSafe = chars(`${ALNUM}_.~-`, 12, 40);
const queryParameter = fc
  .tuple(
    fc.constantFrom("?", "?limit=10&"),
    fc.constantFrom("api_key", "apikey", "api-key", "apiKey", "key", "access_token", "token"),
    urlSafe,
    fc.constantFrom("", "&limit=10", "#models"),
  )
  .map(
    ([lead, name, value, tail]): Planted => ({
      text: `https://models.example.com/v1/models${lead}${name}=${value}${tail}`,
      secret: value,
    }),
  );

const urlUserinfo = fc.tuple(fc.constantFrom("", "user:", ":"), urlSafe).map(
  ([user, value]): Planted => ({
    text: `https://${user}${value}@models.example.com/v1/models`,
    secret: value,
  }),
);

const shapes = {
  "a bare key": bareKey,
  "a token after an authorization scheme": schemeToken,
  "a credential assigned bare, quoted, backticked, escaped or cut off": assigned,
  "the value of an Authorization header under any scheme": authorizationHeader,
  "a credential that is an object or array": nestedCredential,
  "a credential in a JSON body": jsonBody,
  "a credential in a URL query": queryParameter,
  "a credential in a URL's userinfo": urlUserinfo,
};
const anyShape = fc.oneof(...Object.values(shapes));

const before = fc.constantFrom(" ", "\n", " (", ", ", ": ", " [", "; ");
const after = fc.constantFrom(" ", "\n");

function inMessage(planted: fc.Arbitrary<Planted>) {
  return fc
    .tuple(prose, before, planted, after, prose)
    .map(([lead, open, { text, secret, openEnded }, close, trail]) => ({
      message: `${lead}${open}${text}${openEnded ? "\n" : close}${trail}`,
      secret,
      lead,
      trail,
    }));
}

const fragment = fc.constantFrom(
  '"',
  "'",
  "`",
  "\\",
  '\\"',
  ":",
  "=",
  " ",
  "\n",
  ",",
  "}",
  "{",
  "-",
  "_",
  ".",
  "/",
  "://",
  "@",
  "?",
  "&",
  "#",
  "sk-",
  "Bearer",
  "bearer ",
  "Basic ",
  "Digest ",
  "api",
  "key",
  "api_key",
  "apikey",
  "API key",
  "token",
  "secret",
  "password",
  "Authorization",
  "provided",
  "abcdefgh",
  "A1b2C3d4",
  "x",
  "•••",
);
const fragments = fc.array(fragment, { maxLength: 16 }).map((parts) => parts.join(""));

describe("sanitizeModelConnectionError properties", () => {
  it.each(Object.entries(shapes))(
    "never leaves %s in the message, whole or in part",
    (_name, shape) => {
      fc.assert(
        fc.property(inMessage(shape), ({ message, secret }) => {
          expect(survivingPart(secret, sanitizeModelConnectionError(message))).toBeUndefined();
        }),
        { seed: SEED, numRuns: 300 },
      );
    },
  );

  it("keeps the words before and after a redacted credential", () => {
    fc.assert(
      fc.property(inMessage(anyShape), ({ message, lead, trail }) => {
        const cleaned = sanitizeModelConnectionError(message);
        expect(cleaned.startsWith(lead)).toBe(true);
        expect(cleaned.endsWith(trail)).toBe(true);
        expect(cleaned).toContain("•••");
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it("changes nothing when cleaning an already cleaned message", () => {
    const anyMessage = fc.oneof(
      inMessage(anyShape).map(({ message }) => message),
      fragments,
    );
    fc.assert(
      fc.property(anyMessage, (message) => {
        const cleaned = sanitizeModelConnectionError(message);
        expect(sanitizeModelConnectionError(cleaned)).toBe(cleaned);
      }),
      { seed: SEED, numRuns: 1000 },
    );
  });

  it("returns a message without credential markers unchanged apart from outer whitespace", () => {
    const plain = fc.string({
      unit: fc.oneof(
        fc.constantFrom(...without(`${VISIBLE_ASCII} \n`, ":=-bB")),
        fc.constantFrom("é", "ü", "日", "😀", "•"),
      ),
      maxLength: 120,
    });
    fc.assert(
      fc.property(plain, (message) => {
        expect(sanitizeModelConnectionError(message)).toBe(message.trim());
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it("leaves sentences that only name a credential unchanged", () => {
    const sentenceWord = fc.constantFrom(
      "bearer",
      "Bearer",
      "Basic",
      "of",
      "bad",
      "news",
      "authentication",
      "is",
      "required",
      "token",
      "expired",
      "API",
      "key",
      "secret",
      "password",
      "credentials",
      "authorization",
      "rejected",
      "Incorrect",
      "provided.",
      "token:",
      "Authorization:",
      "missing,",
    );
    const sentence = fc
      .array(sentenceWord, { minLength: 1, maxLength: 12 })
      .map((words) => words.join(" "));
    fc.assert(
      fc.property(sentence, (message) => {
        expect(sanitizeModelConnectionError(message)).toBe(message);
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  describe("with the credential the connection was tested with", () => {
    const anyText = fc.oneof(
      fragments,
      fc.string({ unit: "binary", maxLength: 60 }),
      inMessage(anyShape).map(({ message }) => message),
    );
    // The marker itself is not a credential: a value made of it would read as already hidden.
    const knownSecretOf = (minLength: number, maxLength: number) =>
      fc
        .string({
          unit: fc.oneof(
            fc.constantFrom(...VISIBLE_ASCII, " ", "\t"),
            fc.constantFrom("é", "ü", "日", "😀"),
          ),
          minLength,
          maxLength,
        })
        .map((value) => value.trim())
        .filter((value) => value.length >= minLength);
    const knownSecret = knownSecretOf(4, 60);
    // From this length a known credential is hidden even inside other text.
    const longKnownSecret = knownSecretOf(8, 60);
    const shortKnownSecret = knownSecretOf(4, 7);
    const lowerCaseEscapes = (encoded: string) =>
      encoded.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());
    const mixedCaseEscapes = (encoded: string) =>
      encoded.replace(/%[0-9A-F]{2}/g, (hex, index: number) =>
        index % 2 ? hex.toLowerCase() : hex,
      );
    const written = fc.constantFrom<(secret: string) => string>(
      (secret) => secret,
      (secret) => encodeURIComponent(secret),
      (secret) => lowerCaseEscapes(encodeURIComponent(secret)),
      (secret) => mixedCaseEscapes(encodeURIComponent(secret)),
      (secret) => encodeURIComponent(secret).replaceAll("%20", "+"),
      (secret) => lowerCaseEscapes(encodeURIComponent(secret)).replaceAll("%20", "+"),
      (secret) => JSON.stringify(secret).slice(1, -1),
      (secret) => JSON.stringify(secret).slice(1, -1).replaceAll("/", "\\/"),
    );

    it("never leaves it anywhere in the message, as entered or encoded", () => {
      fc.assert(
        fc.property(
          anyText,
          longKnownSecret,
          written,
          anyText,
          fc.constantFrom("", " ", "\n\t"),
          (lead, secret, write, trail, padding) => {
            const message = `${lead}${write(secret)}${trail}`;
            const cleaned = sanitizeModelConnectionError(message, [padding + secret + padding]);
            expect(cleaned).not.toContain(secret);
            expect(cleaned).not.toContain(write(secret));
          },
        ),
        { seed: SEED, numRuns: 1000 },
      );
    });

    it("never leaves a short one where it stands alone, as entered or encoded", () => {
      const edge = fc.constantFrom(" ", "\n", "=", ":", '"', "'", "/", "&", "(", ")", ",");
      fc.assert(
        fc.property(
          anyText,
          edge,
          shortKnownSecret,
          written,
          edge,
          anyText,
          (lead, before, secret, write, after, trail) => {
            const alone = `${before}${write(secret)}${after}`;
            const cleaned = sanitizeModelConnectionError(`${lead}${alone}${trail}`, [secret]);
            expect(cleaned).not.toContain(alone);
          },
        ),
        { seed: SEED, numRuns: 1000 },
      );
    });

    it("gives the same result when cleaned again", () => {
      fc.assert(
        fc.property(anyText, knownSecret, anyText, (lead, secret, trail) => {
          const cleaned = sanitizeModelConnectionError(`${lead}${secret}${trail}`, [secret]);
          expect(sanitizeModelConnectionError(cleaned, [secret])).toBe(cleaned);
        }),
        { seed: SEED, numRuns: 500 },
      );
    });
  });
});
