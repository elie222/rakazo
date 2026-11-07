import type {
  IntegrationCatalogResult,
  IntegrationCatalogSurface,
  McpServer,
} from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { findOrAddMcpServer, signInMcpServers } from "./integration-catalog.js";

function result(
  name: string,
  surfaces: Array<Pick<IntegrationCatalogSurface, "kind" | "source" | "auth">>,
): IntegrationCatalogResult {
  return {
    domain: `${name}.example`,
    name,
    description: "",
    pageUrl: null,
    surfaces: surfaces.map((surface, index) => ({ slug: `${name}-${index}`, ...surface })),
  };
}

const oauth = { type: "oauth", headerName: null, note: null } as const;

describe("signInMcpServers", () => {
  it("offers remote servers that sign in or need no credential", () => {
    expect(
      signInMcpServers([
        result("Tracker", [
          { kind: "mcp", source: "https://mcp.tracker.example/mcp", auth: oauth },
        ]),
        result("Docs", [
          {
            kind: "mcp",
            source: "https://docs.example/mcp",
            auth: { type: "none", headerName: null, note: null },
          },
        ]),
        result("Notes", [{ kind: "mcp", source: "https://notes.example/mcp", auth: null }]),
      ]),
    ).toEqual([
      { name: "Tracker", endpoint: "https://mcp.tracker.example/mcp" },
      { name: "Docs", endpoint: "https://docs.example/mcp" },
      { name: "Notes", endpoint: "https://notes.example/mcp" },
    ]);
  });

  it("leaves out servers that need a key, plain HTTP, and other surfaces", () => {
    expect(
      signInMcpServers([
        result("Code", [
          {
            kind: "mcp",
            source: "https://code.example/mcp",
            auth: { type: "bearer", headerName: null, note: "Personal token" },
          },
          {
            kind: "mcp",
            source: "https://code.example/keyed",
            auth: { type: "header", headerName: "x-api-key", note: null },
          },
          { kind: "mcp", source: "http://code.example/mcp", auth: oauth },
          { kind: "openapi", source: "https://code.example/openapi.json", auth: oauth },
          { kind: "mcp", source: null, auth: oauth },
        ]),
      ]),
    ).toEqual([]);
  });

  it("lists a server shared by several results once", () => {
    const surface = {
      kind: "mcp",
      source: "https://mcp.tracker.example/mcp",
      auth: oauth,
    } as const;

    expect(
      signInMcpServers([result("Tracker", [surface]), result("Tracker app", [surface])]),
    ).toEqual([{ name: "Tracker", endpoint: "https://mcp.tracker.example/mcp" }]);
  });
});

describe("findOrAddMcpServer", () => {
  const tracker = { name: "Tracker", endpoint: "https://mcp.tracker.example/mcp" };

  it("reuses the server already added for the endpoint", async () => {
    const saved = { id: "saved", enabled: true, endpoint: tracker.endpoint } as McpServer;
    const create = vi.fn();

    await expect(findOrAddMcpServer(tracker, { list: async () => [saved], create })).resolves.toBe(
      saved,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("reuses a server saved under an equivalent URL", async () => {
    const saved = { id: "saved", enabled: true, endpoint: "https://mcp.example" } as McpServer;
    const create = vi.fn();

    await expect(
      findOrAddMcpServer(
        { name: "Example", endpoint: "https://mcp.example/" },
        { list: async () => [saved], create },
      ),
    ).resolves.toBe(saved);
    expect(create).not.toHaveBeenCalled();
  });

  it("adds a new server rather than reuse a disabled one", async () => {
    const disabled = { id: "off", enabled: false, endpoint: tracker.endpoint } as McpServer;
    const create = vi.fn(async () => ({ id: "new" }) as McpServer);

    await expect(
      findOrAddMcpServer(tracker, { list: async () => [disabled], create }),
    ).resolves.toEqual({ id: "new" });
  });

  it("adds a remote server for a new endpoint", async () => {
    const create = vi.fn(async () => ({ id: "new" }) as McpServer);

    await findOrAddMcpServer(tracker, { list: async () => [], create });

    expect(create).toHaveBeenCalledWith({
      slug: expect.stringMatching(/^integration-[a-z0-9-]{8}$/),
      name: "Tracker",
      transport: "streamable_http",
      endpoint: tracker.endpoint,
    });
  });
});
