import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "./redaction.js";

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
const LOWER = UPPER.toLowerCase();
const DIGITS = "0123456789";
const ALNUM = UPPER + LOWER + DIGITS;
const BASE64URL = `${ALNUM}_-`;
const VISIBLE_ASCII = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join("");

const alnum = chars(ALNUM, 12, 40);
const endsAlnum = (body: fc.Arbitrary<string>) =>
  fc.tuple(body, chars(ALNUM, 1, 1)).map(([head, last]) => head + last);
const base64url = endsAlnum(chars(BASE64URL, 12, 40));

const word = fc.constantFrom(
  "request",
  "failed",
  "while",
  "calling",
  "upstream",
  "retrying",
  "after",
  "error",
  "status",
  "from",
  "the",
  "server",
);
const prose = fc.array(word, { maxLength: 6 }).map((words) => words.join(" "));
const before = fc.constantFrom(
  " ",
  "\n",
  " (",
  ' "',
  " '",
  " `",
  ", ",
  ": ",
  "=",
  " [",
  " <",
  "; ",
);
const after = fc.constantFrom(" ", "\n", ") ", '" ', "' ", "` ", ", ", ". ", "; ", "] ", "> ", "");

type Planted = { text: string; secret: string };

const bearer = fc
  .tuple(
    fc.constantFrom("Bearer", "bearer", "BEARER"),
    fc.constantFrom(" ", "  ", "\t"),
    endsAlnum(chars(`${ALNUM}-._~+/`, 12, 40)),
    fc.constantFrom("", "=", "=="),
  )
  .map(
    ([scheme, gap, token, padding]): Planted => ({
      text: `${scheme}${gap}${token}${padding}`,
      secret: token,
    }),
  );

const secretName = fc.constantFrom(
  "password",
  "secret",
  "token",
  "authorization",
  "apikey",
  "api_key",
);
const mixedCase = (name: fc.Arbitrary<string>) =>
  fc
    .tuple(name, fc.constantFrom("lower", "upper", "title"))
    .map(([value, style]) =>
      style === "upper"
        ? value.toUpperCase()
        : style === "title"
          ? value[0]!.toUpperCase() + value.slice(1)
          : value,
    );
const assignmentKey = fc.oneof(
  fc
    .tuple(
      fc.constantFrom("", "PG", "client_", "DB_", "x-", "Proxy-", "refresh"),
      mixedCase(secretName),
      fc.constantFrom("", "_value", "2", "Hash"),
    )
    .map((parts) => parts.join("")),
  fc
    .tuple(fc.constantFrom("", "x-", "X-"), mixedCase(fc.constant("api-key")))
    .map((parts) => parts.join("")),
);
const assignment = fc
  .tuple(
    assignmentKey,
    fc.constantFrom("=", ":", ": ", " = ", " : ", ":\t"),
    fc.constantFrom("", "Basic ", "bearer ", "Digest ", "token "),
    chars(VISIBLE_ASCII, 12, 40),
  )
  .map(
    ([key, separator, scheme, value]): Planted => ({
      text: `${key}${separator}${scheme}${value}`,
      secret: value,
    }),
  );

const jsonSecretName = fc.constantFrom(
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "apikey",
  "api_key",
  "api-key",
  "email",
  "cookie",
  "credential",
);
const jsonField = fc
  .tuple(
    fc.constantFrom("", "access_", "x-", "client-", "user"),
    mixedCase(jsonSecretName),
    fc.constantFrom("", "_value", "-id", "s"),
    fc.constantFrom(":", ": ", " : ", ":\n  "),
    fc.string({ unit: "grapheme", minLength: 12, maxLength: 40 }),
  )
  .map(
    ([prefix, name, suffix, separator, value]): Planted => ({
      text: `{"id":"r1","${prefix}${name}${suffix}"${separator}${JSON.stringify(value)},"code":401}`,
      secret: JSON.stringify(value).slice(1, -1),
    }),
  );

const bareKey = fc.oneof(
  fc
    .tuple(fc.constantFrom("sk-", "sk-or-v1-"), base64url)
    .map(([prefix, body]): Planted => ({ text: prefix + body, secret: body })),
  fc
    .tuple(fc.constantFrom("ak_", "ck_"), alnum)
    .map(([prefix, body]): Planted => ({ text: prefix + body, secret: body })),
);

const jwt = fc
  .tuple(base64url, base64url, base64url)
  .map(([header, payload, signature]): Planted => {
    const text = `eyJ${header}.${payload}.${signature}`;
    return { text, secret: text };
  });

const email = fc
  .tuple(
    chars(`${LOWER}${DIGITS}`, 1, 8),
    chars(`${LOWER}${DIGITS}._%+-`, 0, 12),
    chars(`${LOWER}${DIGITS}`, 1, 4),
    fc.array(chars(`${LOWER}${DIGITS}-`, 1, 10), { minLength: 1, maxLength: 3 }),
    chars(LOWER, 2, 6),
    fc.boolean(),
  )
  .map(([first, middle, last, labels, tld, upper]): Planted => {
    const address = `${first}${middle}${last}@${labels.join(".")}.${tld}`;
    const text = upper ? address.toUpperCase() : address;
    return { text, secret: text };
  });

const shareLinkAt = (origin: fc.Arbitrary<string>) =>
  fc
    .tuple(
      origin,
      fc.constantFrom("/p/", "/api/v1/pages/shared/"),
      fc.constantFrom("", "q3-plan-", "notes-"),
      base64url,
      fc.constantFrom("", "?x=1", "#top", "/"),
    )
    .map(
      ([host, path, slug, token, tail]): Planted => ({
        text: `${host}${path}${slug}${token}${tail}`,
        secret: token,
      }),
    );
const absoluteShareLink = shareLinkAt(
  fc.constantFrom("https://app.example.com", "http://localhost:3000", "https://example.com:8443"),
);
const relativeShareLink = shareLinkAt(fc.constant(""));

const echoedHeader = fc
  .tuple(
    fc.constantFrom('"', '\\"'),
    fc.string({ unit: "grapheme", minLength: 12, maxLength: 60 }),
    fc.boolean(),
  )
  .map(
    ([quote, value, complete]): Planted => ({
      text: `Headers.append: ${quote}${value}${complete ? `${quote} is an invalid header value.` : ""}`,
      secret: value,
    }),
  );

const accountName = endsAlnum(chars(`${LOWER}${DIGITS}._-`, 8, 20));
const posixProfile = fc
  .tuple(fc.constantFrom("/home/", "/Users/"), accountName, fc.constantFrom("", "/app/data.db"))
  .map(([root, name, rest]): Planted => ({ text: `${root}${name}${rest}`, secret: name }));
const windowsProfile = fc
  .tuple(
    fc.constantFrom("C:\\Users\\", "D:/Users/", "c:\\users\\"),
    fc.oneof(
      accountName,
      fc.tuple(accountName, accountName).map((names) => names.join(" ")),
    ),
    fc.constantFrom("", "\\AppData\\app.db", "/app.db"),
  )
  .map(([root, name, rest]): Planted => ({ text: `${root}${name}${rest}`, secret: name }));

const connectionString = fc
  .tuple(
    fc.constantFrom("postgres", "postgresql", "redis", "https"),
    fc.constantFrom("app", "admin", ""),
    fc
      .tuple(chars(ALNUM, 1, 1), endsAlnum(chars(`${ALNUM}._%+-`, 11, 40)))
      .map((parts) => parts.join("")),
    fc.constantFrom("db.example.com", "cache.internal.example.net", "example.org"),
    fc.constantFrom("", ":5432", ":5432/app", "/app?sslmode=require"),
  )
  .map(
    ([scheme, user, password, host, rest]): Planted => ({
      text: `${scheme}://${user}:${password}@${host}${rest}`,
      secret: password,
    }),
  );

const stableShapes = {
  "a bearer token": bearer,
  "a value assigned to a secret-named key": assignment,
  "a JSON string field with a secret-named key": jsonField,
  "a bare API key": bareKey,
  "a signed web token": jwt,
  "an email address": email,
  "a password in a connection string": connectionString,
  "a shared page link with its origin": absoluteShareLink,
  "an account name in a POSIX profile path": posixProfile,
};
const shapes = {
  ...stableShapes,
  "a shared page path": relativeShareLink,
  "an echoed header value": echoedHeader,
  "an account name in a Windows profile path": windowsProfile,
};
const anyShape = fc.oneof(...Object.values(shapes));

function inText(planted: fc.Arbitrary<Planted>) {
  return fc
    .tuple(prose, before, planted, after, prose)
    .map(([lead, open, { text, secret }, close, trail]) => ({
      text: `${lead}${open}${text}${close}${trail}`,
      secret,
    }));
}

const fragment = fc.constantFrom(
  '"',
  "'",
  ":",
  "=",
  "@",
  "/",
  "\\",
  ".",
  "-",
  "_",
  " ",
  "\n",
  ",",
  ";",
  "&",
  "{",
  "}",
  "(",
  ")",
  "Bearer ",
  "token",
  "password",
  "secret",
  "api-key",
  "authorization",
  "basic ",
  "sk-",
  "sk-or-v1-",
  "ak_",
  "eyJ",
  "://",
  "https://a.example",
  "/home/",
  "/Users/",
  "abcdefgh",
  "A1b2C3d4",
  "x",
  "9",
  ".com",
  "[Redacted]",
  "[user]",
  '\\"',
  "email",
);

const HOSTILE_LENGTH = 60_000;
const hostileUnit = fc.constantFrom(
  '"',
  "'",
  ":",
  "=",
  "@",
  "/",
  "\\",
  ".",
  "-",
  "_",
  " ",
  "\n",
  "a",
  "a@",
  "a.",
  "a@a.a1",
  "eyJ-",
  "eyJa.",
  "sk-",
  "ak_",
  "/p",
  "/p/",
  "://",
  "token",
  "token ",
  '"token":"',
  '"token":"\\',
  '\\"',
  "Bearer ",
  "C:\\Users\\",
  "/home/",
  'Headers.append: "',
);
const hostile = fc
  .tuple(
    fc.constantFrom("", "a@", '"token":"', "sk-", "eyJ", "https://", "token"),
    fc.array(hostileUnit, { minLength: 1, maxLength: 3 }).map((units) => units.join("")),
    fc.constantFrom("", '"', ":", "@a.aa", "/p/x", "\n"),
  )
  .map(([head, unit, tail]) => head + unit.repeat(Math.ceil(HOSTILE_LENGTH / unit.length)) + tail);

function elapsed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("redactSensitiveText properties", () => {
  it.each(Object.entries(shapes))(
    "never leaves %s in the text, whole or in part",
    (_name, shape) => {
      fc.assert(
        fc.property(inText(shape), ({ text, secret }) => {
          expect(survivingPart(secret, redactSensitiveText(text))).toBeUndefined();
        }),
        { seed: 42, numRuns: 300 },
      );
    },
  );

  it("never leaves any of several secrets planted in one text", () => {
    const planted = fc.array(fc.tuple(before, anyShape, after, prose), {
      minLength: 2,
      maxLength: 4,
    });
    fc.assert(
      fc.property(planted, (pieces) => {
        const text = pieces
          .map(([open, { text }, close, trail]) => `${open}${text}${close}${trail}`)
          .join(" ");
        const redacted = redactSensitiveText(text);
        for (const [, { secret }] of pieces) {
          expect(survivingPart(secret, redacted)).toBeUndefined();
        }
      }),
      { seed: 42, numRuns: 300 },
    );
  });

  it("changes nothing when redacting already redacted text", () => {
    const anyText = fc
      .array(
        fc.oneof(
          fragment,
          fc.oneof(...Object.values(stableShapes)).map(({ text }) => text),
        ),
        { maxLength: 12 },
      )
      .map((pieces) => pieces.join(""));
    fc.assert(
      fc.property(anyText, (text) => {
        const redacted = redactSensitiveText(text);
        expect(redactSensitiveText(redacted)).toBe(redacted);
      }),
      { seed: 42, numRuns: 1000 },
    );
  });

  it("returns text that cannot form a sensitive shape unchanged", () => {
    const plain = fc.string({
      unit: fc.oneof(
        fc.constantFrom(...VISIBLE_ASCII.replace(/[:=@/\\bBkKJ]/g, ""), " ", "\n", "\t"),
        fc.constantFrom("é", "ü", "日", "😀"),
      ),
      maxLength: 200,
    });
    fc.assert(
      fc.property(plain, (text) => {
        expect(redactSensitiveText(text)).toBe(text);
      }),
      { seed: 42, numRuns: 300 },
    );
  });

  it("redacts pattern-starting text in time comparable to plain text of the same length", () => {
    // Measured against plain text on the same machine, so a slow or busy runner cannot fail it.
    const plainText = "plain words ".repeat(HOSTILE_LENGTH / 12);
    const fastestOf = (text: string) =>
      Math.min(...[0, 1, 2].map(() => elapsed(() => redactSensitiveText(text))));
    const budget = Math.max(100, fastestOf(plainText) * 50);
    fc.assert(
      fc.property(hostile, (text) => {
        expect(fastestOf(text)).toBeLessThan(budget);
      }),
      { seed: 42, numRuns: 40 },
    );
  });
});
