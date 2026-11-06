import { describe, expect, it } from "vitest";
import {
  boundToolActivityText,
  redactToolActivityJson,
  redactToolActivityLine,
  redactToolActivityText,
  redactToolActivityValue,
  toolActivityCallFields,
} from "./tool-activity-redaction.js";

describe("tool activity redaction", () => {
  it("drops any value under a credential-named key, at any depth", () => {
    expect(
      redactToolActivityValue(
        {
          secret_key: "wJalrX",
          aws_secret_access_key: "k",
          headers: { "Set-Cookie": ["sid=abc123"] },
          password: 12345678,
          auth: { user: "a", pass: "b" },
          pin: true,
          key: "Enter",
        },
        [],
      ),
    ).toEqual({
      secret_key: "[redacted]",
      aws_secret_access_key: "[redacted]",
      headers: { "Set-Cookie": "[redacted]" },
      password: "[redacted]",
      auth: "[redacted]",
      pin: true,
      key: "Enter",
    });
  });

  it("drops strings under credential-named keys at any depth", () => {
    expect(
      redactToolActivityValue(
        {
          headers: { Authorization: "Token abc123", "X-Api-Key": "k-1" },
          password: "hunter2",
          accessToken: "t-1",
          session_id: "s-1",
          max_tokens: 100,
          author: "Ana",
          list: [{ client_secret: "c-1", query: "weather" }],
        },
        [],
      ),
    ).toEqual({
      headers: { Authorization: "[redacted]", "X-Api-Key": "[redacted]" },
      password: "[redacted]",
      accessToken: "[redacted]",
      session_id: "[redacted]",
      max_tokens: 100,
      author: "Ana",
      list: [{ client_secret: "[redacted]", query: "weather" }],
    });
  });

  it("redacts the run's secrets inside values, before JSON could escape them", () => {
    const secret = 'pa"ss\\word\nline';
    const safe = redactToolActivityValue({ note: `token=${secret}` }, [secret]);
    expect(JSON.stringify(safe)).not.toContain("pa");
  });

  it("redacts JSON a tool returned value by value, and JSON inside other text by its members", () => {
    const json = '{"password": 1234, "name": "Ana", "nested": {"api_key":"k-1"}}';
    expect(JSON.parse(redactToolActivityText(json, []))).toEqual({
      password: "[redacted]",
      name: "Ana",
      nested: { api_key: "[redacted]" },
    });
    expect(redactToolActivityText('Sent {"token": "t-1", "pin": 4321} to Ana', [])).toBe(
      'Sent {"token": "[redacted]", "pin": "[redacted]"} to Ana',
    );
  });

  it("cuts only after redacting", () => {
    expect(boundToolActivityText("abcdef", 3)).toBe("abc…");
    expect(boundToolActivityText("abc", 3)).toBe("abc");
  });

  it("leaves a line as it ran apart from what it redacts, and big numbers as they were", () => {
    expect(redactToolActivityLine('{"a":1}', [])).toBe('{"a":1}');
    expect(redactToolActivityLine('curl -d \'{"password":"hunter2"}\' x', [])).toBe(
      'curl -d \'{"password":"[redacted]"}\' x',
    );
    expect(redactToolActivityText('{"id": 1790000000000000123}', [])).toBe(
      '{"id": 1790000000000000123}',
    );
  });

  it("passes serialized JSON once more whole, for a secret that spans values", () => {
    expect(redactToolActivityJson({ a: "to", b: "ken-1" }, ['"to",\n  "b": "ken-1'])).not.toContain(
      "ken-1",
    );
  });

  it("gives a call its line and JSON arguments, and a shell its whole command instead", () => {
    expect(toolActivityCallFields("web_search", { query: "weather", api_key: "k-1" }, [])).toEqual({
      detail: "weather",
      input: '{\n  "query": "weather",\n  "api_key": "[redacted]"\n}',
    });
    const long = `echo ${"a".repeat(300)} TOKEN=s-1`;
    const shell = toolActivityCallFields("shell", { command: long, cwd: "." }, ["s-1"]);
    expect(shell.input).toBeUndefined();
    expect(shell.command).toBe(`echo ${"a".repeat(300)} TOKEN=[redacted]`);
    expect(shell.detail?.length).toBeLessThanOrEqual(200);
    expect(toolActivityCallFields("remember", {}, [])).toEqual({});
  });
});
