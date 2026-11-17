import { describe, expect, it } from "vitest";
import { McpHeadersSchema, McpServerConfigInput } from "./mcp.js";

describe("MCP headers", () => {
  it.each(["streamable_http", "sse"])("accepts underscore headers for %s", (transport) => {
    const headers = { X_API_KEY: "fake-key" };
    expect(
      McpServerConfigInput.safeParse({
        slug: "demo",
        name: "Demo",
        transport,
        endpoint: "https://mcp.example.test",
        headers,
      }).success,
    ).toBe(true);
  });

  it("accepts all HTTP token punctuation without changing names or values", () => {
    const headers = { "X!#$%&'*+-.^_`|~": "fake-key", Authorization: "Bearer fake-token" };
    expect(McpHeadersSchema.parse(headers)).toEqual(headers);
  });

  it.each([
    "",
    "X Key",
    " X-Key",
    "X-Key ",
    "X-\u00e9",
    ...Array.from('()<>@,;:\\"/[]?={}', (char) => `X${char}Key`),
    ...Array.from({ length: 33 }, (_, index) => {
      const char = String.fromCharCode(index === 32 ? 127 : index);
      return `X-Key${char}`;
    }),
  ])("rejects invalid header name %j", (name) => {
    expect(McpHeadersSchema.safeParse({ [name]: "fake-key" }).success).toBe(false);
  });

  it("keeps the header count and value length limits", () => {
    const input = {
      slug: "demo",
      name: "Demo",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test",
    };
    const headers = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`X_Key_${index}`, "x".repeat(4096)]),
    );
    expect(McpServerConfigInput.safeParse({ ...input, headers }).success).toBe(true);
    expect(
      McpServerConfigInput.safeParse({ ...input, headers: { ...headers, X_Extra: "fake-key" } })
        .success,
    ).toBe(false);
    expect(
      McpServerConfigInput.safeParse({ ...input, headers: { X_Key: "x".repeat(4097) } }).success,
    ).toBe(false);
  });
});
