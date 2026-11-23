import { describe, expect, it } from "vitest";
import { assertMcpRemoteEndpoint } from "./mcp-servers.js";

describe("assertMcpRemoteEndpoint", () => {
  const withLookup = (code: string) =>
    ({
      env: {},
      remoteConnectors: {
        resolveHostname: async () => {
          throw Object.assign(new Error(`getaddrinfo ${code} tools.example.test`), { code });
        },
      },
    }) as never;

  it("says when the host does not exist instead of showing the lookup error", async () => {
    await expect(
      assertMcpRemoteEndpoint("https://tools.example.test/mcp", withLookup("ENOTFOUND")),
    ).rejects.toThrow(/^Connector URL host could not be found$/);
  });

  it("keeps other lookup failures as they are", async () => {
    await expect(
      assertMcpRemoteEndpoint("https://tools.example.test/mcp", withLookup("EAI_AGAIN")),
    ).rejects.toThrow("getaddrinfo EAI_AGAIN");
  });
});
