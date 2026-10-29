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

  it("handles a full-envelope-sized failed email candidate without blocking", () => {
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
         const text = "a.".repeat(512 * 1024);
         process.stdout.write(String(redactSensitiveText(text) === text));`,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(output).toBe("true");
  });

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
});
