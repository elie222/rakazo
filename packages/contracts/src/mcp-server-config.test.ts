import { describe, expect, it } from "vitest";
import { parseMcpServerConfig } from "./mcp.js";

const url = "https://gateway.example.com:8019/mcp";

describe("parseMcpServerConfig", () => {
  it("reads the server and bearer token from an mcpServers config", () => {
    const config = {
      mcpServers: { desktop: { url, headers: { Authorization: "Bearer test-token" } } },
    };
    expect(parseMcpServerConfig(JSON.stringify(config, null, 2))).toEqual({
      url,
      token: "test-token",
    });
  });

  it("reads a single server, with or without its name around it", () => {
    expect(parseMcpServerConfig(JSON.stringify({ url }))).toEqual({ url });
    expect(
      parseMcpServerConfig(
        JSON.stringify({ desktop: { url, headers: { authorization: "bearer test-token" } } }),
      ),
    ).toEqual({ url, token: "test-token" });
  });

  it("leaves URLs, broken JSON and other configs alone", () => {
    expect(parseMcpServerConfig(url)).toBeNull();
    expect(parseMcpServerConfig('{"mcpServers": {')).toBeNull();
    expect(
      parseMcpServerConfig(JSON.stringify({ mcpServers: { local: { command: "npx" } } })),
    ).toBeNull();
    // Only a bearer Authorization header carries the token.
    expect(
      parseMcpServerConfig(JSON.stringify({ url, headers: { "X-Api-Key": "test-token" } })),
    ).toEqual({ url });
  });
});
