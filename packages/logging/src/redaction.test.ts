import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { redactBindings, redactSensitiveText } from "./redaction.js";
import { createTestSink } from "./test-sink.js";

describe("redaction", () => {
  it.each([
    'Headers.append: "fake pasted snippet\nPGPASSWORD=fake-value" is an invalid header value.',
    'Headers.append: "fake pasted snippet\nPGPASSWORD=fake-value',
    'Headers.append: "fake "quoted" snippet" is an invalid header value.',
  ])("redacts echoed header values throughout log events: %s", (message) => {
    const fixed = 'Headers.append: "[Redacted]" is an invalid header value.';
    expect(redactSensitiveText(message)).toBe(fixed);
    const sink = createTestSink();
    const logger = createLogger({ service: "logging-test", sinks: [sink] });
    const error = new TypeError(message);
    error.stack = `TypeError: ${message}\n    at fetch (example.js:1:1)`;
    logger.error(message, error, { reason: message });
    expect(sink.events[0]).toMatchObject({
      message: fixed,
      reason: fixed,
      error: {
        message: fixed,
        stack: message.endsWith("value.")
          ? `TypeError: ${fixed}\n    at fetch (example.js:1:1)`
          : `TypeError: ${fixed}`,
      },
    });
    expect(JSON.stringify(sink.events)).not.toContain("fake");
  });

  it("redacts echoed headers in serialized structured provider failures", () => {
    const message = 'Headers.append: "fake pasted snippet" is an invalid header value.';
    const sink = createTestSink();
    const logger = createLogger({ service: "logging-test", sinks: [sink] });
    logger.warn("run.failed", { error: { diagnostic: message }, reason: message });
    expect(sink.events[0]).toMatchObject({
      reason: 'Headers.append: "[Redacted]" is an invalid header value.',
      error: {
        message: JSON.stringify({
          diagnostic: 'Headers.append: "[Redacted]" is an invalid header value.',
        }),
      },
    });
    expect(JSON.stringify(sink.events)).not.toContain("fake pasted snippet");
  });

  it("preserves non-header messages in plain-object failures", () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "logging-test", sinks: [sink] });
    const error = { message: "fixture failure" };
    logger.warn("run.failed", { error });
    expect(sink.events[0]).toMatchObject({
      error: { message: JSON.stringify(error) },
    });
  });

  it("preserves numeric request budgets without exposing token values or content", () => {
    expect(
      redactBindings({
        requestedMaxTokens: 2048,
        nested: { effective_max_tokens: 512 },
        items: [{ effectiveMaxTokens: 0, accessToken: 1234 }],
        token: 1234,
        prompt: "fixture content",
      }),
    ).toEqual({
      requestedMaxTokens: 2048,
      nested: { effective_max_tokens: 512 },
      items: [{ effectiveMaxTokens: 0, accessToken: "[Redacted]" }],
      token: "[Redacted]",
      prompt: "[Redacted]",
    });
  });

  it.each([
    "fixture-secret",
    { apiKey: "fixture-secret" },
    ["fixture-secret"],
    null,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("redacts non-count values in budget fields: %j", (value) => {
    expect(redactBindings({ requestedMaxTokens: value, effectiveMaxTokens: value })).toEqual({
      requestedMaxTokens: "[Redacted]",
      effectiveMaxTokens: "[Redacted]",
    });
  });

  it.each(["a.", "eyJ-"])(
    "handles a full-envelope-sized failed candidate without blocking: %s",
    (part) => {
      const moduleUrl = new URL("./redaction.ts", import.meta.url).href;
      // A child deadline also catches synchronous regex stalls that block the test runner's timers.
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import { redactSensitiveText } from ${JSON.stringify(moduleUrl)};
         const text = ${JSON.stringify(part)}.repeat(1024 * 1024 / ${part.length});
         process.stdout.write(String(redactSensitiveText(text) === text));`,
        ],
        { encoding: "utf8", timeout: 5_000 },
      );
      expect(output).toBe("true");
    },
  );

  it("keeps non-email candidates and redacts adjacent and punctuated email addresses", () => {
    expect(
      redactSensitiveText(
        "a.b.c a-b-c (first.last+tag@example.com), next@example.net+other@example.org",
      ),
    ).toBe("a.b.c a-b-c ([Redacted]), [Redacted][Redacted]");
  });

  it("redacts secrets, credentials, and message bodies", () => {
    const redacted = redactBindings({
      "user.id": "user-1",
      email: "person@example.com",
      authorization: "Bearer secret",
      cookie: "session=abc",
      prompt: "do not log",
      messages: [{ role: "user", content: "hi" }],
      body: { text: "payload" },
      query: { q: "search" },
      apiKey: "sk-live",
      nested: { password: "hunter2", token: "abc", safe: true },
    });
    expect(redacted["user.id"]).toBe("user-1");
    expect(redacted.email).toBe("[Redacted]");
    expect(redacted.authorization).toBe("[Redacted]");
    expect(redacted.cookie).toBe("[Redacted]");
    expect(redacted.prompt).toBe("[Redacted]");
    expect(redacted.messages).toBe("[Redacted]");
    expect(redacted.body).toBe("[Redacted]");
    expect(redacted.query).toBe("[Redacted]");
    expect(redacted.apiKey).toBe("[Redacted]");
    expect(redacted.nested).toEqual({ password: "[Redacted]", token: "[Redacted]", safe: true });
  });

  it("redacts message content keys at any depth", () => {
    const contentKeys = [
      "content",
      "text",
      "blocks",
      "parts",
      "input",
      "output",
      "stdout",
      "stderr",
      "arguments",
      "transcript",
      "completion",
      "html",
      "markdown",
    ];
    const payload = Object.fromEntries(contentKeys.map((key) => [key, `private ${key}`]));

    const redacted = redactBindings({
      ...payload,
      Stdout: "private Stdout",
      nested: { tool: { name: "shell", ...payload } },
      items: [{ id: "a", ...payload }],
    });

    for (const key of contentKeys) expect(redacted[key]).toBe("[Redacted]");
    expect(redacted.Stdout).toBe("[Redacted]");
    expect(redacted.nested).toEqual({
      tool: { name: "shell", ...Object.fromEntries(contentKeys.map((key) => [key, "[Redacted]"])) },
    });
    expect(redacted.items).toEqual([
      { id: "a", ...Object.fromEntries(contentKeys.map((key) => [key, "[Redacted]"])) },
    ]);
    expect(JSON.stringify(redacted)).not.toContain("private");
  });

  it("keeps metadata fields whose names only contain a content key", () => {
    const redacted = redactBindings({
      "output.chars": 120,
      "stdout.bytes": 4,
      "text.length": 9,
      "content.type": "text/plain",
      "input.items": 30,
    });

    expect(redacted).toEqual({
      "output.chars": 120,
      "stdout.bytes": 4,
      "text.length": 9,
      "content.type": "text/plain",
      "input.items": 30,
    });
  });

  it("replaces circular values", () => {
    const cycle: Record<string, unknown> = { "request.id": "r1" };
    cycle.self = cycle;
    const redacted = redactBindings(cycle);
    expect(redacted["request.id"]).toBe("r1");
    expect(redacted.self).toBe("[Circular]");
  });

  it("redacts Error values nested in bindings", () => {
    const cause = new Error("password=inner-secret");
    const error = new Error("request failed with token=outer-secret", { cause });

    const redacted = redactBindings({ detail: error });

    expect(redacted.detail).toMatchObject({
      name: "Error",
      message: "request failed with token=[Redacted]",
      cause: { name: "Error", message: "password=[Redacted]" },
    });
    expect(JSON.stringify(redacted.detail)).not.toMatch(/inner-secret|outer-secret/);
  });

  it("redacts string Error causes", () => {
    const error = new Error("request failed", { cause: "token=cause-secret" });

    const redacted = redactBindings({ detail: error });

    expect(redacted.detail).toMatchObject({
      name: "Error",
      message: "request failed",
      cause: "token=[Redacted]",
    });
    expect(JSON.stringify(redacted.detail)).not.toContain("cause-secret");
  });

  it("redacts secrets embedded in string binding values", () => {
    const redacted = redactBindings({
      detail: "token=binding-secret",
      nested: { note: "Bearer nested-secret" },
    });

    expect(redacted).toEqual({
      detail: "token=[Redacted]",
      nested: { note: "Bearer [Redacted]" },
    });
  });

  it("redacts secrets embedded in free text", () => {
    const redacted = redactSensitiveText(
      "user person@example.com used Bearer supersecret and token=abc123",
    );
    expect(redacted).toContain("[Redacted]");
    expect(redacted).not.toContain("person@example.com");
    expect(redacted).not.toContain("supersecret");
    expect(redacted).not.toContain("abc123");
  });

  it("redacts bare API keys and JWTs in free text", () => {
    const redacted = redactSensitiveText(
      "key sk-or-v1-abc123456789 and sk-live-secret99 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig ak_secretvaluehere",
    );
    expect(redacted).not.toMatch(
      /sk-or-v1-abc123456789|sk-live-secret99|eyJhbGciOiJIUzI1NiJ9|ak_secretvaluehere/,
    );
    expect(redacted).toContain("[Redacted]");
  });

  it("redacts quoted JSON credential fields", () => {
    const redacted = redactSensitiveText(
      '{"password":"hunter2","token":"abc","authorization":"Bearer secret"}',
    );
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain('"token":"abc"');
    expect(redacted).not.toContain("Bearer secret");
    expect(redacted).toContain('"password":"[Redacted]"');
    expect(redacted).toContain('"token":"[Redacted]"');
    expect(redacted).toContain('"authorization":"[Redacted]"');
  });

  it.each([
    "Authorization: Basic ZmFrZTpmaXh0dXJl",
    "Authorization: token fixture-credential",
    "proxy-authorization=Digest fixture-credential",
    "x-api-key: fixture-credential",
    "X-API-KEY=fixture-credential",
  ])("redacts header credentials in free text: %s", (header) => {
    const redacted = redactSensitiveText(`request failed with ${header} attached`);
    expect(redacted).toContain("=[Redacted] attached");
    expect(redacted).not.toMatch(/ZmFrZTpmaXh0dXJl|fixture-credential/);
  });

  it.each([
    ["eyJ-header.payload.signature", "[Redacted]"],
    ["eyJ-header.payload.signature-", "[Redacted]-"],
    ["eyJ-header.payload", "eyJ-header.payload"],
    ["eyJ-header-ak_fixture", "eyJ-header-[Redacted]"],
    ["eyJ-header-sk-fixturesecret", "eyJ-header-[Redacted]"],
    ["sk-fixture-eyJheader.payload.signature", "[Redacted].payload.signature"],
    ["eyJ-header-sk-fixturesecret.payload.signature", "[Redacted]"],
  ])("preserves JWT and key redaction within candidates: %s", (text, expected) => {
    expect(redactSensitiveText(text)).toBe(expected);
  });

  it("redacts quoted JSON fields whose names contain a secret name", () => {
    expect(
      redactSensitiveText(
        'Raw body: {"access_token":"fixture-a","refresh_token":"fixture-r","client_secret":"fixture-s","x-api-key":"fixture-k","client_id":"public-id"}',
      ),
    ).toBe(
      'Raw body: {"access_token":"[Redacted]","refresh_token":"[Redacted]","client_secret":"[Redacted]","x-api-key":"[Redacted]","client_id":"public-id"}',
    );
  });

  it("handles a long word made of secret names without blocking", () => {
    const moduleUrl = new URL("./redaction.ts", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { redactSensitiveText } from ${JSON.stringify(moduleUrl)};
         const text = "token".repeat(200 * 1024) + ' "' + "secret".repeat(100 * 1024);
         process.stdout.write(String(redactSensitiveText(text) === text));`,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(output).toBe("true");
  });

  it("redacts a shared page's link anywhere in text, and leaves other paths", () => {
    const token = "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9";
    expect(
      redactSensitiveText(
        `Failed to open https://app.example.com/p/q3-plan-${token}: 404\n` +
          `    at GET /api/v1/pages/shared/${token}?x=1 (fetch)\n` +
          `next=https://a.example/go?to=https://b.example/p/plan-${token}#top ` +
          `"/p/${token}" /app/p/page1 src/p/index.ts`,
      ),
    ).toBe(
      "Failed to open https://app.example.com/p/[Redacted]: 404\n" +
        "    at GET /api/v1/pages/shared/[Redacted]?x=1 (fetch)\n" +
        "next=https://a.example/go?to=https://b.example/p/[Redacted]#top " +
        '"/p/[Redacted]" /app/p/page1 src/p/index.ts',
    );
    const logged = JSON.stringify(
      redactBindings({
        err: new Error(`open https://app.example.com/p/plan-${token}`),
        url: `/p/${token}`,
      }),
    );
    expect(logged).not.toContain(token);
  });

  it("scans text full of link-like paths without blocking", () => {
    const moduleUrl = new URL("./redaction.ts", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { redactSensitiveText } from ${JSON.stringify(moduleUrl)};
         const text = "https://" + ("x".repeat(64 * 1024) + "/p").repeat(16) + "a/p".repeat(200 * 1024);
         process.stdout.write(String(redactSensitiveText(text) === text));`,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(output).toBe("true");
  });

  it("redacts user profile paths in free text", () => {
    expect(redactSensitiveText("cannot open /home/example-user/app.db")).toBe(
      "cannot open /[user]/app.db",
    );
    expect(redactSensitiveText("cannot open /Users/example-user/app.db")).toBe(
      "cannot open /[user]/app.db",
    );
    expect(redactSensitiveText("cannot open C:\\Users\\example-user\\app.db")).toBe(
      "cannot open [user]\\app.db",
    );
  });

  it.each([
    [
      "postgres://app:hunter2secret@localhost:5432/db",
      "postgres://app:[Redacted]@localhost:5432/db",
    ],
    ["postgres://app:hunter2secret@db:5432", "postgres://app:[Redacted]@db:5432"],
    ["postgres://app:hunter2secret@10.0.0.5", "postgres://app:[Redacted]@10.0.0.5"],
    ["redis://:pw@redis:6379", "redis://:[Redacted]@redis:6379"],
    [
      "DATABASE_URL=postgres://app:hunter2secret@localhost/db",
      "DATABASE_URL=postgres://app:[Redacted]@localhost/db",
    ],
    [
      "postgres://app:Secr3t!xyz@db.example.com:5432/db",
      "postgres://app:[Redacted]@db.example.com:5432/db",
    ],
    ["amqp://guest:p@ss!w0rd@[::1]:5672/vhost", "amqp://guest:[Redacted]@[::1]:5672/vhost"],
    ["mysql://app:pa/ss#w0rd@db/app", "mysql://app:[Redacted]@db/app"],
    [
      '{"cache":"redis://:hunter2secret@cache:6379","owner":"team"}',
      '{"cache":"redis://:[Redacted]@cache:6379","owner":"team"}',
    ],
  ])("redacts the password in a connection string: %s", (text, expected) => {
    expect(redactSensitiveText(text)).toBe(expected);
  });

  it("redacts secret fields in JSON embedded in a JSON string", () => {
    expect(redactSensitiveText('{\\"password\\":\\"hunter2secret\\"}')).toBe(
      '{\\"password\\":\\"[Redacted]\\"}',
    );
    const embedded = JSON.stringify({ body: JSON.stringify({ user: "u1", token: "fixture one" }) });
    expect(redactSensitiveText(embedded)).toBe(
      '{"body":"{\\"user\\":\\"u1\\",\\"token\\":\\"[Redacted]\\"}"}',
    );
  });

  it.each([
    ["Authorization: Negotiate hunter2secret", "Authorization=[Redacted]"],
    ["Authorization: ApiKey hunter2secret", "Authorization=[Redacted]"],
    [
      'Authorization: Digest username="fixture", realm="fixture realm", response="hunter2secret" sent',
      "Authorization=[Redacted] sent",
    ],
  ])("redacts the credential after any authorization scheme: %s", (text, expected) => {
    expect(redactSensitiveText(text)).toBe(expected);
  });

  it.each([
    ["Cookie: session=hunter2secret", "Cookie=[Redacted]"],
    ["Cookie: theme=dark; session=hunter2secret was rejected", "Cookie=[Redacted] was rejected"],
    ["Set-Cookie: session=hunter2secret; Path=/; HttpOnly", "Set-Cookie=[Redacted] HttpOnly"],
    ["passwd=hunter2secret", "passwd=[Redacted]"],
    ["credential=hunter2secret", "credential=[Redacted]"],
  ])("redacts cookies and every secret-like name in free text: %s", (text, expected) => {
    expect(redactSensitiveText(text)).toBe(expected);
  });

  it("treats one list of names as secret in structured keys", () => {
    expect(
      redactBindings({
        passwd: "fixture",
        my_api_key: "fixture",
        "x-api-key": "fixture",
        sessionCookie: "fixture",
        userCredential: "fixture",
        attempt: 2,
      }),
    ).toEqual({
      passwd: "[Redacted]",
      my_api_key: "[Redacted]",
      "x-api-key": "[Redacted]",
      sessionCookie: "[Redacted]",
      userCredential: "[Redacted]",
      attempt: 2,
    });
  });

  it.each([
    ['password="my pass phrase"', "password=[Redacted]"],
    ["password='my pass phrase' attempt=2", "password=[Redacted] attempt=2"],
    ['password="my pass phrase', "password=[Redacted]"],
    ['--password "my pass phrase" --verbose', "--password [Redacted] --verbose"],
  ])("redacts a whole quoted value: %s", (text, expected) => {
    expect(redactSensitiveText(text)).toBe(expected);
  });

  it.each([
    ['{"db.password":"x"}', '{"db.password":"[Redacted]"}'],
    ["{'password': 'x'}", "{'password': '[Redacted]'}"],
    ['{"token": 12345678}', '{"token": [Redacted]}'],
    ['{"tokens": ["x"]}', '{"tokens": [Redacted]}'],
    ['"password" => "x"', '"password" => "[Redacted]"'],
    ['{"id":1,"tokens":["x","y z"],"ok":true}', '{"id":1,"tokens":[Redacted],"ok":true}'],
    ["{ password: 'x y', attempt: 2 }", "{ password=[Redacted] attempt: 2 }"],
  ])("redacts secret fields in other JSON and dictionary forms: %s", (text, expected) => {
    expect(redactSensitiveText(text)).toBe(expected);
  });

  it.each([
    ["secret-key=hunter2secret", "secret-key=[Redacted]"],
    ["--secret-key hunter2secret", "--secret-key [Redacted]"],
  ])("redacts kebab-case keys wherever the secret word sits: %s", (text, expected) => {
    expect(redactSensitiveText(text)).toBe(expected);
  });

  it.each([
    ["export_person@example.com_2026.csv", "[Redacted]_2026.csv"],
    ["person@example.com2", "[Redacted]2"],
    ["josé@example.com", "[Redacted]"],
  ])("redacts an address whatever follows it or spells it: %s", (text, expected) => {
    expect(redactSensitiveText(text)).toBe(expected);
  });

  it.each([
    ["ak_hunter2_secret", "[Redacted]"],
    ["token_eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", "token_[Redacted]"],
    ["_sk-hunter2secret", "_[Redacted]"],
    ["sk_live_hunter2secret", "[Redacted]"],
  ])("redacts keys and tokens glued to a word character: %s", (text, expected) => {
    expect(redactSensitiveText(text)).toBe(expected);
  });

  it("redacts a shared page's link wherever its path starts", () => {
    const token = "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9";
    expect(redactSensitiveText(`url:/p/${token}`)).toBe("url:/p/[Redacted]");
    expect(redactSensitiveText(`<a>/p/${token}</a>`)).toBe("<a>/p/[Redacted]</a>");
    expect(redactSensitiveText(`next=%2Fp%2F${token}&from=mail`)).toBe(
      "next=%2Fp%2F[Redacted]&from=mail",
    );
    expect(redactSensitiveText(`https://host/en/p/${token}`)).toBe("https://host/en/p/[Redacted]");
    expect(
      redactSensitiveText(`next=https%3A%2F%2Fapp.example.com%3A8443%2Fp%2Fplan-${token}`),
    ).toBe("next=https%3A%2F%2Fapp.example.com%3A8443%2Fp%2F[Redacted]");
  });

  it("redacts a value and a path whole when a name in them holds a space", () => {
    expect(redactSensitiveText("PASSWORD_FILE=C:\\Users\\Jane Doe\\pw.txt")).toBe(
      "PASSWORD_FILE=[Redacted]",
    );
    expect(redactSensitiveText("cannot open /Users/Jane Doe/x")).toBe("cannot open /[user]/x");
    expect(redactSensitiveText("cannot open /home/example-user and /tmp/x")).toBe(
      "cannot open /[user] and /tmp/x",
    );
  });

  it.each([
    ["C:\\Users\\C:\\Users\\bob", "C:\\Users\\[user]"],
    [
      'Headers.append: "fake" is an invalid header value.person@example.com',
      'Headers.append: "[Redacted]" is an invalid header [Redacted]',
    ],
    [
      'https://a.example{"password":"a b"}/p/Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9',
      'https://a.example{"password":"[Redacted]"}/p/[Redacted]',
    ],
    ['password="a b",next=1 then [Redacted][user]', "password=[Redacted] then [Redacted][user]"],
  ])("reaches its final text in one pass: %s", (text, expected) => {
    const redacted = redactSensitiveText(text);
    expect(redacted).toBe(expected);
    expect(redactSensitiveText(redacted)).toBe(redacted);
  });

  it.each([
    "http://localhost:3000/@vite/client",
    "at load (http://[::1]:3000/@fs/app/index.js:1:2)",
    '{"url":"http://localhost:3000","room":"a@b"}',
    "https://registry.example.com:4873/@scope/pkg/-/pkg-1.0.0.tgz",
    "docker://registry:5000/image@sha256:abcdef",
    "file:///C:/work/app/index.js:10:5",
    "GET /app/p/page1 200 in 12ms",
    "task-12345678 finished; risk-assessment queued",
    "break_ak_x keyJson.parse.call",
    "C:\\Program Files\\App\\run.exe exited with 1",
    "retry in 5s: upstream 503 (attempt 2/5), cache=miss",
  ])("leaves text that only resembles a secret unchanged: %s", (text) => {
    expect(redactSensitiveText(text)).toBe(text);
  });

  it.each([
    ["a URL with a colon and no credentials", `"://a:b/".repeat(150_000)`],
    ["a long URL password that never ends", `"://a:" + "b".repeat(1024 * 1024)`],
    ["percent-encoded link paths", `"%2Fp%2F".repeat(150_000) + "@"`],
    ["blank lines after a secret-named key", `"token=" + "\\n".repeat(1024 * 1024)`],
    ["spaces after a secret-named flag", `"--token" + " ".repeat(1024 * 1024)`],
    ["a secret-named flag before another flag", `"--token -".repeat(120_000)`],
    ["quoted keys made of dotted secret names", `'"' + "token.".repeat(170_000)`],
    [
      "values that open a quote at ever deeper escaping",
      `Array.from({ length: 600 }, (_, depth) => "token:" + "\\\\".repeat(depth % 9) + '"x ').join("").repeat(40)`,
    ],
    ["lists that never close", `'token:["a\\n'.repeat(100_000)`],
    [
      "header parameters",
      `"cookie: a; b=1; ".repeat(60_000) + "authorization: a, b=\\"".repeat(40_000)`,
    ],
    ["profile names followed by more words", `"/Users/a a a a ".repeat(70_000)`],
  ])("handles a megabyte of %s without blocking", (_name, expression) => {
    const moduleUrl = new URL("./redaction.ts", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { redactSensitiveText } from ${JSON.stringify(moduleUrl)};
         const text = ${expression};
         process.stdout.write(String(redactSensitiveText(text).length > 0));`,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(output).toBe("true");
  });
});
