import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { sanitizeModelConnectionError } from "./model-connection-preflight.js";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  plural: (value: number, forms: { one: string; other: string }) =>
    (value === 1 ? forms.one : forms.other).replaceAll("#", String(value)),
}));

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

type Planted = { text: string; secret: string };

const bareKey = fc
  .tuple(fc.constantFrom("sk-", "sk-test-"), endsAlnum(chars(`${ALNUM}_-`, 12, 40)))
  .map(([prefix, body]): Planted => ({ text: prefix + body, secret: body }));

const bearer = fc
  .tuple(
    fc.constantFrom("Bearer", "bearer", "Authorization: Bearer"),
    fc.constantFrom(" ", "  ", "\t"),
    chars(`${ALNUM}_.~+/=-`, 12, 40),
  )
  .map(([scheme, gap, token]): Planted => ({ text: `${scheme}${gap}${token}`, secret: token }));

const keyName = fc.constantFrom(
  "api_key",
  "api-key",
  "apikey",
  "apiKey",
  "API_KEY",
  "Api-Key",
  "x-api-key",
  "X-API-Key",
);
const separator = fc.constantFrom("=", ":", ": ", " = ", " : ", ":\t");
const quotedValue = fc.oneof(
  chars(without(`${VISIBLE_ASCII} `, '"'), 12, 40).map((value) => ({
    quoted: `"${value}"`,
    value,
  })),
  chars(without(`${VISIBLE_ASCII} `, "'"), 12, 40).map((value) => ({
    quoted: `'${value}'`,
    value,
  })),
  chars(without(VISIBLE_ASCII, "\"',}"), 12, 40).map((value) => ({ quoted: value, value })),
  chars(without(VISIBLE_ASCII, "\"',}`"), 12, 40).map((value) => ({
    quoted: `\`${value}\``,
    value,
  })),
);
const assignedKey = fc.tuple(fc.constantFrom("", '"', "'"), keyName, separator, quotedValue).map(
  ([keyQuote, key, gap, { quoted, value }]): Planted => ({
    text: `${keyQuote}${key}${keyQuote}${gap}${quoted}`,
    secret: value,
  }),
);

const jsonBody = fc
  .tuple(
    fc.constantFrom("api_key", "apiKey", "api-key", "apikey"),
    fc.constantFrom(":", ": "),
    chars(without(`${VISIBLE_ASCII} `, '"\\'), 12, 40),
  )
  .map(
    ([key, gap, value]): Planted => ({
      text: `{"error":"denied","${key}"${gap}${JSON.stringify(value)},"code":401}`,
      secret: value,
    }),
  );

const queryParameter = fc
  .tuple(
    fc.constantFrom("api_key", "apikey", "api-key", "apiKey"),
    chars(`${ALNUM}_.~-`, 12, 40),
    fc.constantFrom("", "&limit=10", "#models"),
  )
  .map(
    ([name, value, tail]): Planted => ({
      text: `https://models.example.com/v1/models?${name}=${value}${tail}`,
      secret: value,
    }),
  );

const shapes = {
  "a bare key": bareKey,
  "a bearer token": bearer,
  "an API key assigned bare, quoted or backticked": assignedKey,
  "an API key in a JSON body": jsonBody,
  "an API key in a URL query": queryParameter,
};
const anyShape = fc.oneof(...Object.values(shapes));

const before = fc.constantFrom(" ", "\n", " (", ", ", ": ", " [", "; ");
const after = fc.constantFrom(" ", "\n");

function inMessage(planted: fc.Arbitrary<Planted>) {
  return fc
    .tuple(prose, before, planted, after, prose)
    .map(([lead, open, { text, secret }, close, trail]) => ({
      message: `${lead}${open}${text}${close}${trail}`,
      secret,
      lead,
      trail,
    }));
}

const fragment = fc.constantFrom(
  '"',
  "'",
  "`",
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
  "sk-",
  "Bearer",
  "bearer ",
  "api",
  "key",
  "api_key",
  "apikey",
  "abcdefgh",
  "A1b2C3d4",
  "x",
  "•••",
);

describe("sanitizeModelConnectionError properties", () => {
  it.each(Object.entries(shapes))(
    "never leaves %s in the message, whole or in part",
    (_name, shape) => {
      fc.assert(
        fc.property(inMessage(shape), ({ message, secret }) => {
          expect(survivingPart(secret, sanitizeModelConnectionError(message))).toBeUndefined();
        }),
        { seed: 42, numRuns: 300 },
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
      { seed: 42, numRuns: 300 },
    );
  });

  it("changes nothing when cleaning an already cleaned message", () => {
    const anyMessage = fc.oneof(
      inMessage(anyShape).map(({ message }) => message),
      fc.array(fragment, { maxLength: 12 }).map((parts) => parts.join("")),
    );
    fc.assert(
      fc.property(anyMessage, (message) => {
        const cleaned = sanitizeModelConnectionError(message);
        expect(sanitizeModelConnectionError(cleaned)).toBe(cleaned);
      }),
      { seed: 42, numRuns: 500 },
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
      { seed: 42, numRuns: 300 },
    );
  });
});
