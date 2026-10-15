import { describe, expect, it } from "vitest";
import { redactConnectorPayload, redactModelContextSecrets } from "./connector-safety.js";

describe("redactConnectorPayload", () => {
  it("redacts secrets that JSON escapes in property names and values", () => {
    const secret = 'api"key';

    expect(
      redactConnectorPayload(
        {
          [secret]: `prefix ${secret} suffix`,
          nested: { value: secret },
        },
        [secret],
      ),
    ).toEqual({
      "[redacted]": "prefix [redacted] suffix",
      nested: { value: "[redacted]" },
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

describe("redactModelContextSecrets", () => {
  it("redacts message text and tool arguments while keeping the protocol intact", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "my code is secret" }], timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "secure_pasted_secret",
            arguments: { name: "secret", value: "secret", pin: 482913 },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "secure_pasted_secret",
        content: [{ type: "text", text: "saved secret" }],
      },
    ];
    expect(redactModelContextSecrets(messages, ["secret", "482913"])).toEqual([
      { role: "user", content: [{ type: "text", text: "my code is [redacted]" }], timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "secure_pasted_secret",
            arguments: { name: "[redacted]", value: "[redacted]", pin: "[redacted]" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "secure_pasted_secret",
        content: [{ type: "text", text: "saved [redacted]" }],
      },
    ]);
  });
});
