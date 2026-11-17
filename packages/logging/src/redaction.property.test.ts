import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "./redaction.js";

const SEED = 42;
const RUNS = 300;
const LEAK_LENGTH = 6;

function survivingPart(secret: string, output: string): string | undefined {
  for (let start = 0; start + LEAK_LENGTH <= secret.length; start++) {
    const part = secret.slice(start, start + LEAK_LENGTH);
    if (output.includes(part)) return part;
  }
  return undefined;
}

// A secret that also spells part of the text around it, or of the words redaction writes, would
// be found there afterwards whether or not it was redacted.
const WRITTEN = ' Bearer [Redacted] [user] " is an invalid header value.';
const standsApart = (secret: string, text: string) =>
  survivingPart(secret, text.split(secret).join(" ") + WRITTEN) === undefined;

const chars = (alphabet: string, minLength: number, maxLength: number) =>
  fc.string({ unit: fc.constantFrom(...alphabet), minLength, maxLength });

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = UPPER.toLowerCase();
const DIGITS = "0123456789";
const LETTERS = UPPER + LOWER;
const ALNUM = LETTERS + DIGITS;
const BASE64URL = `${ALNUM}_-`;
const VISIBLE_ASCII = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join("");

const alnum = chars(ALNUM, 12, 40);
const visible = chars(VISIBLE_ASCII, 12, 40);
// A value that opens with a quote runs to the quote that closes it, and `=>` is a separator, so a
// bare one opens otherwise.
const bare = fc
  .tuple(chars(VISIBLE_ASCII.replace(/["'\\>]/g, ""), 1, 1), chars(VISIBLE_ASCII, 11, 39))
  .map((parts) => parts.join(""));
const endsAlnum = (body: fc.Arbitrary<string>) =>
  fc.tuple(body, chars(ALNUM, 1, 1)).map(([head, last]) => head + last);
const base64url = endsAlnum(chars(BASE64URL, 12, 40));
// Spaces inside, never at either end, so the phrase is one value only when its quotes are honoured.
// No lower case, so no part of it can also be a word of the text around it.
const phrase = fc
  .array(chars(`${UPPER}${DIGITS}!#$%&()*+,-./:;<=>?@[]^_{|}~`, 3, 10), {
    minLength: 2,
    maxLength: 4,
  })
  .map((words) => words.join(" "));

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
  ">",
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
  "passwd",
  "secret",
  "token",
  "authorization",
  "cookie",
  "credential",
  "apikey",
  "api_key",
  "api-key",
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
const assignmentKey = fc
  .tuple(
    fc.constantFrom("", "PG", "client_", "DB_", "x-", "Proxy-", "refresh", "db.", "--"),
    mixedCase(secretName),
    fc.constantFrom("", "_value", "2", "Hash", "-key", "-id", "_FILE"),
  )
  .map((parts) => parts.join(""));
const assignmentSeparator = fc.constantFrom("=", ":", ": ", " = ", " : ", ":\t", " => ", "=>");
const assignment = fc
  .tuple(
    assignmentKey,
    assignmentSeparator,
    fc.constantFrom("", "Basic ", "bearer ", "Digest ", "token "),
    bare,
  )
  .map(
    ([key, separator, scheme, value]): Planted => ({
      text: `${key}${separator}${scheme}${value}`,
      secret: value,
    }),
  );
// A bare key goes on through dotted parts before `=`; before `:` it would be a file and a line.
const dottedAssignment = fc
  .tuple(
    fc.constantFrom("", "app.", "jwt.", "--"),
    mixedCase(secretName),
    fc.constantFrom(".key", ".hash", ".value.raw", ".v1.primary.current.id"),
    fc.constantFrom("=", " = ", " => ", "=>"),
    bare,
  )
  .map(
    ([prefix, name, rest, separator, value]): Planted => ({
      text: `${prefix}${name}${rest}${separator}${value}`,
      secret: value,
    }),
  );
const quotedAssignment = fc
  .tuple(assignmentKey, assignmentSeparator, fc.constantFrom('"', "'"), phrase)
  .map(
    ([key, separator, quote, value]): Planted => ({
      text: `${key}${separator}${quote}${value}${quote}`,
      secret: value,
    }),
  );
const flag = fc
  .tuple(
    fc.constantFrom("--", "--db-", "--client-"),
    secretName,
    fc.constantFrom("", "-key", "-file"),
    fc.constantFrom(" ", "  ", "\t"),
    fc.oneof(
      fc.tuple(chars(ALNUM, 1, 1), visible).map((parts) => ({ text: parts.join(""), quote: "" })),
      fc.tuple(phrase, fc.constantFrom('"', "'")).map(([text, quote]) => ({ text, quote })),
    ),
  )
  .map(
    ([dashes, name, suffix, gap, value]): Planted => ({
      text: `${dashes}${name}${suffix}${gap}${value.quote}${value.text}${value.quote}`,
      secret: value.text,
    }),
  );

const authorizationHeader = fc
  .tuple(
    fc.constantFrom("Authorization", "authorization", "Proxy-Authorization", "X-Authorization"),
    fc.constantFrom(": ", ":", "=", " = "),
    fc.constantFrom("Negotiate", "ApiKey", "Mutual", "SCRAM-SHA-256", "Basic", "Bearer"),
    fc.constantFrom(" ", "  ", "\t"),
    visible,
  )
  .map(
    ([name, separator, scheme, gap, credential]): Planted => ({
      text: `${name}${separator}${scheme}${gap}${credential}`,
      secret: credential,
    }),
  );
// A cookie's own name is often secret-like, and the cookies after it are still the header's.
const cookieName = fc.oneof(
  chars(LOWER, 2, 8),
  fc.constantFrom("session_token", "csrftoken", "auth-token", "secret"),
);
const cookieHeader = fc
  .tuple(
    fc.constantFrom("Cookie", "cookie", "Set-Cookie"),
    fc.constantFrom(": ", ":", "="),
    fc.array(fc.tuple(cookieName, alnum), { minLength: 0, maxLength: 2 }),
    cookieName,
    alnum,
    fc.constantFrom("", "; Path=/; HttpOnly"),
  )
  .map(
    ([header, separator, others, name, value, attributes]): Planted => ({
      text: `${header}${separator}${[...others, [name, value]]
        .map((pair) => pair.join("="))
        .join("; ")}${attributes}`,
      secret: value,
    }),
  );

const fieldName = fc.constantFrom(
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
const fieldKey = fc
  .tuple(
    fc.constantFrom("", "access_", "x-", "client-", "user", "db.", "config.auth."),
    mixedCase(fieldName),
    fc.constantFrom("", "_value", "-id", "s", ".hash"),
  )
  .map((parts) => parts.join(""));
const fieldSeparator = fc.constantFrom(":", ": ", " : ", ":\n  ", " => ", "=>");
const jsonField = fc
  .tuple(fieldKey, fieldSeparator, fc.string({ unit: "grapheme", minLength: 12, maxLength: 40 }))
  .map(
    ([key, separator, value]): Planted => ({
      text: `{"id":"r1","${key}"${separator}${JSON.stringify(value)},"code":401}`,
      secret: JSON.stringify(value).slice(1, -1),
    }),
  );
// The key of the second value follows the first value with nothing between them but punctuation,
// or as the next parameter of a header.
const gluedAssignment = fc
  .tuple(
    fc.oneof(
      alnum.map((value) => `token=${value}`),
      phrase.map((value) => `password="${value}"`),
      alnum.map((value) => `token=[${value}`),
      alnum.map((value) => `token=[${value}]`),
      alnum.map((value) => `"token": ${value}`),
      alnum.map((value) => `Cookie: sid=${value}`),
      alnum.map((value) => `Authorization: Negotiate ${value}`),
    ),
    fc.constantFrom(",", ";", "&", " {", ", ", ";  "),
    fc.oneof(
      fc
        .tuple(
          secretName,
          fc.constantFrom("=", ": ", " = ", ":\n  ", "=>"),
          fc.constantFrom("", "Basic ", "digest "),
          bare,
        )
        .map(([key, separator, scheme, value]) => ({
          text: `${key}${separator}${scheme}${value}`,
          secret: value,
        })),
      fc.tuple(visible).map(([value]) => ({
        text: `Authorization=Negotiate ${value}`,
        secret: value,
      })),
      fc.tuple(secretName, fieldSeparator, phrase).map(([key, separator, value]) => ({
        text: `"${key}"${separator}"${value}"`,
        secret: value,
      })),
    ),
  )
  .map(
    ([first, glue, second]): Planted => ({
      text: `${first}${glue}${second.text}`,
      secret: second.secret,
    }),
  );
const escaped = (json: string) => JSON.stringify(json).slice(1, -1);
const escapedJsonField = fc
  .tuple(
    fieldKey,
    fc.constantFrom(":", ": "),
    fc.string({ unit: "grapheme", minLength: 12, maxLength: 40 }),
    fc.boolean(),
  )
  .map(([key, separator, value, twice]): Planted => {
    const once = {
      text: escaped(`{"id":"r1","${key}"${separator}${JSON.stringify(value)},"code":401}`),
      secret: escaped(JSON.stringify(value).slice(1, -1)),
    };
    return twice ? { text: escaped(once.text), secret: escaped(once.secret) } : once;
  });
const singleQuotedField = fc.tuple(fieldKey, fc.constantFrom(":", ": ", " : ", " => "), phrase).map(
  ([key, separator, value]): Planted => ({
    text: `{'id': 'r1', '${key}'${separator}'${value}', 'code': 401}`,
    secret: value,
  }),
);
const unquotedField = fc
  .tuple(
    fieldKey,
    fieldSeparator,
    fc.oneof(
      chars(DIGITS, 12, 20).map((text) => ({ text, secret: text })),
      fc
        .tuple(fc.array(alnum, { maxLength: 2 }), alnum, fc.constantFrom(",", ", "))
        .map(([others, secret, comma]) => ({
          text: `[${[...others, secret].map((item) => JSON.stringify(item)).join(comma)}]`,
          secret,
        })),
      fc.tuple(alnum, phrase).map(([name, secret]) => ({
        text: `{"${name}": ${JSON.stringify(secret)}}`,
        secret,
      })),
    ),
    fc.constantFrom(",", "}", ", ", " }"),
  )
  .map(
    ([key, separator, value, end]): Planted => ({
      text: `{"id":"r1","${key}"${separator}${value.text}${end}"code":401}`,
      secret: value.secret,
    }),
  );

// A key or signed token stays one when it follows an underscore.
const glued = fc.constantFrom("", "_", "id_", "key_");
const bareKey = fc.oneof(
  fc
    .tuple(glued, fc.constantFrom("sk-", "sk-or-v1-"), base64url)
    .map(([glue, prefix, body]): Planted => ({ text: glue + prefix + body, secret: body })),
  fc
    .tuple(fc.constantFrom("ak_", "ck_", "sk_live_", "sk_test_"), base64url)
    .map(([prefix, body]): Planted => ({ text: prefix + body, secret: body })),
);

const jwt = fc
  .tuple(glued, base64url, base64url, base64url)
  .map(([glue, header, payload, signature]): Planted => {
    const token = `eyJ${header}.${payload}.${signature}`;
    return { text: glue + token, secret: token };
  });

const email = fc
  .tuple(
    chars(`${LOWER}${DIGITS}éüñяω`, 1, 8),
    chars(`${LOWER}${DIGITS}._%+-éüñяω`, 0, 12),
    chars(`${LOWER}${DIGITS}`, 1, 4),
    fc.array(chars(`${LOWER}${DIGITS}-`, 1, 10), { minLength: 1, maxLength: 3 }),
    chars(LOWER, 2, 6),
    fc.boolean(),
    fc.constantFrom("", "_2026.csv", "_", "7", "-export"),
  )
  .map(([first, middle, last, labels, tld, upper, tail]): Planted => {
    const address = `${first}${middle}${last}@${labels.join(".")}.${tld}`;
    const secret = upper ? address.toUpperCase() : address;
    return { text: secret + tail, secret };
  });

const shareToken = fc
  .tuple(fc.constantFrom("", "q3-plan-", "notes-"), base64url)
  .map(([slug, token]) => ({ text: slug + token, secret: token }));
const sharePath = fc.constantFrom("/p/", "/api/v1/pages/shared/");
const shareLinkAt = (origin: fc.Arbitrary<string>) =>
  fc.tuple(origin, sharePath, shareToken, fc.constantFrom("", "?x=1", "#top", "/", "&x=1")).map(
    ([host, path, token, tail]): Planted => ({
      text: `${host}${path}${token.text}${tail}`,
      secret: token.secret,
    }),
  );
const shareOrigin = fc
  .tuple(
    fc.constantFrom("https://app.example.com", "http://localhost:3000", "https://example.com:8443"),
    fc.constantFrom("", "/en", "/pt-BR"),
  )
  .map((parts) => parts.join(""));
const absoluteShareLink = shareLinkAt(shareOrigin);
const relativeShareLink = shareLinkAt(fc.constantFrom("", "/en", "url:", "href=", "}"));
const encodedShareLink = fc
  .tuple(
    fc.constantFrom("next=", "redirect="),
    fc.oneof(fc.constant(""), shareOrigin),
    sharePath,
    shareToken,
    fc.constantFrom("", "?x=1", "&x=1"),
    fc.boolean(),
  )
  .map(([parameter, origin, path, token, tail, twice]): Planted => {
    const once = encodeURIComponent(`${origin}${path}${token.text}`);
    return {
      text: `${parameter}${twice ? encodeURIComponent(once) : once}${tail}`,
      secret: token.secret,
    };
  });

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
const spacedName = fc.tuple(accountName, accountName).map((names) => names.join(" "));
const posixProfile = fc
  .tuple(
    fc.constantFrom("/home/", "/Users/"),
    fc.oneof(
      fc.tuple(accountName, fc.constantFrom("", "/app/data.db")),
      fc.tuple(spacedName, fc.constantFrom("/app/data.db", "/")),
    ),
  )
  .map(([root, [name, rest]]): Planted => ({ text: `${root}${name}${rest}`, secret: name }));
const windowsProfile = fc
  .tuple(
    fc.constantFrom("C:\\Users\\", "D:/Users/", "c:\\users\\"),
    fc.oneof(accountName, spacedName),
    fc.constantFrom("", "\\AppData\\app.db", "/app.db"),
  )
  .map(([root, name, rest]): Planted => ({ text: `${root}${name}${rest}`, secret: name }));

// A password may hold any visible character. Three readings are left to the URL itself: a number
// that ends where a URL can is a port, `://` starts the next URL, and a quote ends a URL in text,
// so a password holds a quote or an `@` but not both.
const URL_STOPS = "\"'<>\\`";
const withoutUrlStops = VISIBLE_ASCII.split("")
  .filter((char) => !URL_STOPS.includes(char))
  .join("");
const urlPassword = fc
  .oneof(chars(VISIBLE_ASCII.replace("@", ""), 12, 40), chars(`${withoutUrlStops}@@@@`, 12, 40))
  .filter(
    (password) => !/^\d{1,5}[.:!]*["'<>,;)\]}\\&/?#`]/.test(password) && !password.includes("://"),
  );
const connectionString = fc
  .tuple(
    fc.constantFrom("", "DATABASE_URL=", "url: "),
    fc.constantFrom("postgres", "postgresql", "mysql", "redis", "amqp", "sftp", "https"),
    fc.constantFrom("app", "admin", "", "ops@example.com"),
    urlPassword,
    fc.constantFrom(
      "db.example.com",
      "example.org",
      "localhost",
      "db",
      "my_db",
      "10.0.0.5",
      "[::1]",
    ),
    fc.constantFrom("", ":5432", ":5432/app", "/app?sslmode=require", ": refused", "."),
  )
  .map(
    ([prefix, scheme, user, password, host, rest]): Planted => ({
      text: `${prefix}${scheme}://${user}:${password}@${host}${rest}`,
      secret: password,
    }),
  );
// Several URLs with credentials in one list, as a cluster's addresses are written.
const connectionStringList = fc
  .tuple(alnum, urlPassword, alnum, fc.constantFrom(",", ";", ", "))
  .map(
    ([first, password, last, comma]): Planted => ({
      text: `amqp://app:${first}@mq1:5672${comma}amqp://app:${password}@mq2:5672${comma}amqp://app:${last}@mq3`,
      secret: password,
    }),
  );

// The markers redaction writes and the two characters it works with, as they may stand in text
// that is redacted: a marker stops no rule, whatever is written straight after it.
const marker = fc.constantFrom("[Redacted]", "[user]", "\uFDD0", "\uFDD1");
const afterMarker = fc.oneof(
  fc
    .tuple(assignmentKey, assignmentSeparator, marker, visible)
    .map(([key, separator, mark, value]) => ({
      text: `${key}${separator}${mark}${value}`,
      secret: value,
    })),
  fc.tuple(fieldKey, fieldSeparator, marker, alnum).map(([key, separator, mark, value]) => ({
    text: `{"id":"r1","${key}"${separator}${mark}${value},"code":401}`,
    secret: value,
  })),
  fc.tuple(secretName, marker, visible).map(([name, mark, value]) => ({
    text: `--${name} ${mark}${value}`,
    secret: value,
  })),
  fc.tuple(marker, base64url).map(([mark, token]) => ({
    text: `Bearer ${mark}${token}`,
    secret: token,
  })),
  fc
    .tuple(fc.constantFrom("", "/en"), sharePath, marker, base64url)
    .map(([locale, path, mark, token]) => ({
      text: `${locale}${path}${mark}${token}`,
      secret: token,
    })),
  fc
    .tuple(
      fc.constantFrom(
        (mark: string) => `${mark}:`,
        (mark: string) => `app:${mark}`,
        (mark: string) => `ops${mark}:`,
      ),
      marker,
      urlPassword,
    )
    .map(([credentials, mark, password]) => ({
      text: `postgres://${credentials(mark)}${password}@db.example.com:5432/app`,
      secret: password,
    })),
);

const shapes = {
  "a bearer token": bearer,
  "a value assigned to a secret-named key": assignment,
  "a value assigned to a dotted key with a secret name in it": dottedAssignment,
  "a quoted value with spaces assigned to a secret-named key": quotedAssignment,
  "a value whose secret-named key follows another value directly": gluedAssignment,
  "a value after a secret-named command-line flag": flag,
  "a credential after any authorization scheme": authorizationHeader,
  "a cookie in a header": cookieHeader,
  "a JSON string field with a secret-named key": jsonField,
  "a secret-named field in escaped JSON": escapedJsonField,
  "a single-quoted field with a secret-named key": singleQuotedField,
  "a number, list or object under a secret-named key": unquotedField,
  "a bare API key": bareKey,
  "a signed web token": jwt,
  "an email address": email,
  "a password in a connection string": connectionString,
  "a password in a list of connection strings": connectionStringList,
  "a shared page link with its origin": absoluteShareLink,
  "a shared page path": relativeShareLink,
  "a percent-encoded shared page link": encodedShareLink,
  "an echoed header value": echoedHeader,
  "an account name in a POSIX profile path": posixProfile,
  "an account name in a Windows profile path": windowsProfile,
  "a secret written straight after a marker": afterMarker,
};
const anyShape = fc.oneof(...Object.values(shapes));

function inText(planted: fc.Arbitrary<Planted>) {
  return fc
    .tuple(prose, before, planted, after, prose)
    .map(([lead, open, { text, secret }, close, trail]) => ({
      text: `${lead}${open}${text}${close}${trail}`,
      secret,
    }))
    .filter(({ text, secret }) => standsApart(secret, text));
}

// Markers at any place in the text around a secret, most often right against it.
function amongMarkers(planted: fc.Arbitrary<Planted>) {
  const place = fc.oneof(fc.constant(0), fc.nat());
  const marked = (side: "before" | "after") =>
    fc.array(fc.tuple(marker, place), { maxLength: 2 }).map((marks) => (text: string) => {
      let result = text;
      for (const [mark, at] of marks) {
        const offset = at % (result.length + 1);
        const index = side === "before" ? result.length - offset : offset;
        result = result.slice(0, index) + mark + result.slice(index);
      }
      return result;
    });
  return fc
    .tuple(prose, before, marked("before"), planted, marked("after"), after, prose)
    .map(([lead, open, markBefore, { text, secret }, markAfter, close, trail]) => ({
      text: `${markBefore(lead + open)}${text}${markAfter(close + trail)}`,
      secret,
    }))
    .filter(({ text, secret }) => standsApart(secret, text));
}

// Lines a service logs all day that only resemble a secret: its names in prose and file names,
// ports, paths, and at signs that are not addresses.
const name = chars(LOWER, 3, 8).map((letters) => `n${letters}`);
const count = fc.integer({ min: 0, max: 99_999 });
const benignLine = fc.oneof(
  fc.constantFrom(
    "the token expired",
    "password reset requested",
    "invalid credentials",
    "missing authorization header",
    "cookie banner dismissed",
    "secret rotation scheduled",
    "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
    "ENOENT: no such file or directory, open '/app/secrets.json'",
    "2026-11-15T10:42:07.123Z worker started",
    "risk-assessment queued",
    "file:///C:/work/app/index.js:10:5",
  ),
  fc.tuple(name, count, count).map(([id, a, b]) => `GET /api/v1/items/${id} 200 in ${a}ms #${b}`),
  fc.tuple(name, count).map(([id, port]) => `http://localhost:${port}/${id}?page=2&sort=asc`),
  fc.tuple(name, name).map(([host, id]) => `https://${host}.example.com:8443/@${id}/${id}.js`),
  fc
    .tuple(
      name,
      fc.constantFrom("token", "password-reset", "secrets/index", "auth/credential-store"),
      count,
      count,
    )
    .map(([fn, file, line, column]) => `at ${fn} (file:///app/src/${file}.ts:${line}:${column})`),
  fc.tuple(name, count).map(([fn, line]) => `at ${fn} (/app/src/auth/token.ts:${line}:13)`),
  fc
    .tuple(name, name, count)
    .map(([id, tag, n]) => `{"id":"${id}","status":"ok","count":${n},"tags":["${tag}","b"]}`),
  fc.tuple(name, count, count).map(([id, a, b]) => `retry=${a} timeout=${b}s status=${id}`),
  fc
    .tuple(name, count)
    .map(([id, code]) => `C:\\Program Files\\${id}\\run.exe exited with ${code}`),
  fc.tuple(name, count).map(([id, port]) => `redis://${id}-1:${port},redis://${id}-2:${port}`),
  fc.tuple(name, count).map(([id, port]) => `listening on http://${id}:${port}.`),
  fc.tuple(name, name).map(([registry, image]) => `docker://${registry}:5000/${image}@sha256:0a1b`),
  fc.tuple(name, name).map(([scope, id]) => `file://C:/work/node_modules/@${scope}/${id}/index.js`),
  fc.tuple(name, count, count).map(([id, major, minor]) => `@scope/${id}@${major}.${minor}.0`),
  fc.tuple(name, count).map(([id, n]) => `task-${n} finished for @${id} (${n}%)`),
);
const benign = fc
  .tuple(
    benignLine,
    fc.array(fc.tuple(fc.constantFrom(" ", "\n", "; ", " | ", ", "), benignLine), { maxLength: 3 }),
  )
  .map(([first, rest]) => first + rest.map((parts) => parts.join("")).join(""));

const fragment = fc.constantFrom(
  '"',
  "'",
  ":",
  "=",
  "=>",
  "@",
  "/",
  "\\",
  ".",
  "-",
  "--",
  "_",
  " ",
  "\n",
  ",",
  ";",
  "&",
  "%",
  "{",
  "}",
  "[",
  "]",
  "(",
  ")",
  "Bearer ",
  "Negotiate ",
  "token",
  "password",
  "passwd",
  "secret",
  "api-key",
  "authorization",
  "Cookie: ",
  "credential",
  "basic ",
  "sk-",
  "sk_",
  "sk-or-v1-",
  "ak_",
  "eyJ",
  "://",
  "https://a.example",
  "user:",
  "@db",
  ":5432",
  ".key=",
  "/p/",
  "%2Fp%2F",
  "/en",
  "/home/",
  "/Users/",
  "C:\\Users\\",
  'Headers.append: "',
  '" is an invalid header value.',
  "abcdefgh",
  "A1b2C3d4",
  "x",
  "9",
  "é",
  ".com",
  "[Redacted]",
  "[user]",
  "\uFDD0",
  "\uFDD1",
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
  ",",
  ";",
  "[",
  "{",
  "%",
  "a",
  "é",
  "a@",
  "a.",
  "a@a.a1",
  "eyJ-",
  "eyJa.",
  "_eyJ",
  "sk-",
  "sk_",
  "ak_",
  "/p",
  "/p/",
  "%2Fp%2F",
  "/en/p/",
  "://",
  "://a:",
  "://a:b/",
  "://a:1/",
  "://a:1.",
  "://a:b@",
  '://a:"',
  "b@",
  "@a",
  "@a:",
  "token",
  "token ",
  "token.",
  "token-",
  "token.a",
  "token.a.b.c.d ",
  "token=",
  ",token",
  ',"token" ',
  ",token: ",
  ',"token":"',
  "token=a,token=\n",
  "token=[",
  'token:[\\"a\n',
  "cookie: token=a; ",
  "token=>",
  '"token":"',
  '"token":"\\',
  '"a.token',
  "'token':'",
  'token:\\"',
  'token:\\\\\\"',
  "token:[",
  'token:["',
  "token:{",
  "--token ",
  "--token -",
  "cookie: a; ",
  "authorization: a, ",
  "authorization: a ",
  '\\"',
  "Bearer ",
  "C:\\Users\\",
  "/home/",
  "/Users/a ",
  'Headers.append: "',
  "[Redacted]",
  "[user]--token ",
  "\uFDD0",
  "a@a.aa--token ",
  "a@a.aa/p/a",
  "a@a.aa_",
  "-://a",
  ',"token":"a b"',
  ';"token":"a"',
);
const hostile = fc
  .tuple(
    fc.constantFrom("", "a@", '"token":"', "sk-", "eyJ", "https://", "token", "://a:b", "token="),
    fc.array(hostileUnit, { minLength: 1, maxLength: 3 }).map((units) => units.join("")),
    fc.constantFrom("", '"', ":", "@a.aa", "/p/x", "\n", "@", "]", '\\"'),
  )
  .map(([head, unit, tail]) => head + unit.repeat(Math.ceil(HOSTILE_LENGTH / unit.length)) + tail);

// The same few pieces many times over: a rule that took one more of them on each pass would still
// be taking them on the next.
const repeated = fc
  .tuple(
    fc.constantFrom("", "a@", '"token":"', "https://", "token=", "--token ", "/p/a"),
    fc
      .array(
        fc.oneof(
          hostileUnit,
          fragment,
          anyShape.map(({ text }) => text),
        ),
        { minLength: 1, maxLength: 3 },
      )
      .map((units) => units.join("")),
    fc.constantFrom("", " ", ",", ";", "/", "&", "\n"),
    fc.integer({ min: 10, max: 24 }),
    fc.constantFrom("", '"', "@a.aa", "/p/x", "]", " sent"),
  )
  .map(([head, unit, glue, times, tail]) => head + (unit + glue).repeat(times) + tail);

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
        { seed: SEED, numRuns: RUNS },
      );
    },
  );

  it.each(Object.entries(shapes))(
    "never leaves %s among markers written in the text around it",
    (_name, shape) => {
      fc.assert(
        fc.property(amongMarkers(shape), ({ text, secret }) => {
          const redacted = redactSensitiveText(text);
          expect(survivingPart(secret, redacted)).toBeUndefined();
          expect(redactSensitiveText(redacted)).toBe(redacted);
        }),
        { seed: SEED, numRuns: RUNS },
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
        fc.pre(pieces.every(([, { secret }]) => standsApart(secret, text)));
        const redacted = redactSensitiveText(text);
        for (const [, { secret }] of pieces) {
          expect(survivingPart(secret, redacted)).toBeUndefined();
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it("changes nothing when redacting already redacted text", () => {
    const anyText = fc
      .array(
        fc.oneof(
          fragment,
          anyShape.map(({ text }) => text),
        ),
        { maxLength: 12 },
      )
      .map((pieces) => pieces.join(""));
    fc.assert(
      fc.property(anyText, (text) => {
        const redacted = redactSensitiveText(text);
        expect(redactSensitiveText(redacted)).toBe(redacted);
      }),
      { seed: SEED, numRuns: RUNS * 4 },
    );
  });

  it("changes nothing when redacting again text that repeated one shape many times", () => {
    fc.assert(
      fc.property(repeated, (text) => {
        const redacted = redactSensitiveText(text);
        expect(redactSensitiveText(redacted)).toBe(redacted);
      }),
      { seed: SEED, numRuns: RUNS },
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
      { seed: SEED, numRuns: RUNS },
    );
  });

  it("replaces its private characters in the input and writes no marker for them", () => {
    const plain = fc.string({
      unit: fc.oneof(
        fc.constantFrom(...VISIBLE_ASCII.replace(/[:=@/\\bBkKJ]/g, ""), " ", "\n"),
        fc.constantFrom("\uFDD0", "\uFDD1", "\uFFFD"),
      ),
      maxLength: 200,
    });
    fc.assert(
      fc.property(plain, (text) => {
        expect(redactSensitiveText(text)).toBe(text.replace(/[\uFDD0\uFDD1]/g, "\uFFFD"));
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it("returns lines that only resemble a secret unchanged", () => {
    fc.assert(
      fc.property(benign, (text) => {
        expect(redactSensitiveText(text)).toBe(text);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it("redacts pattern-starting text in time comparable to plain text of the same length", () => {
    // Measured against plain text on the same machine, so a slow or busy runner cannot fail it.
    // The plain text names a secret and holds an at sign, so no rule is skipped for it.
    const plainText = "plain token words @ ".repeat(HOSTILE_LENGTH / 20);
    const fastestOf = (text: string) =>
      Math.min(...[0, 1, 2].map(() => elapsed(() => redactSensitiveText(text))));
    const budget = Math.max(100, fastestOf(plainText) * 50);
    fc.assert(
      fc.property(hostile, (text) => {
        expect(fastestOf(text)).toBeLessThan(budget);
      }),
      { seed: SEED, numRuns: 80 },
    );
  });
});
