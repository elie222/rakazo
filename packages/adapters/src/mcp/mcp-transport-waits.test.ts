import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type * as Undici from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { secureFetch } from "./mcp-transport.js";
import { MCP_HTTP_TIMEOUTS } from "./remote-mcp.js";

const agentOptions = vi.hoisted(() => [] as unknown[]);

vi.mock("undici", async (importOriginal) => {
  const undici = await importOriginal<typeof Undici>();
  class RecordedAgent extends undici.Agent {
    constructor(options?: ConstructorParameters<typeof undici.Agent>[0]) {
      super(options);
      agentOptions.push(options);
    }
  }
  return { ...undici, Agent: RecordedAgent };
});

const localPolicy = { allowHttpLocalhost: true, allowPrivateEndpoint: true };
const withLongWaits = (options: unknown) =>
  (options as { headersTimeout?: number } | undefined)?.headersTimeout ===
  MCP_HTTP_TIMEOUTS.headersTimeout;

afterEach(() => {
  agentOptions.length = 0;
});

describe("MCP HTTP waits", () => {
  it("gives a tool call's loopback server the long waits too", async () => {
    const server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    const fetch = secureFetch(url, localPolicy, {}, {}, MCP_HTTP_TIMEOUTS);
    try {
      expect(await (await fetch(url)).text()).toBe("ok");
      // One for remote hosts, one for the permitted loopback server.
      expect(agentOptions.filter(withLongWaits)).toHaveLength(2);
    } finally {
      await fetch.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("keeps the HTTP client's own waits for sign-in requests", async () => {
    const fetch = secureFetch(new URL("https://mcp.example.test/mcp"), {});
    await fetch.close();
    expect(agentOptions.length).toBeGreaterThan(0);
    expect(agentOptions.some(withLongWaits)).toBe(false);
  });
});
