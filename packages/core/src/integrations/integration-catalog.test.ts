import type { IntegrationCatalogResult, IntegrationCatalogSurface } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { browseMcpPresets, mcpSourcePresetsFor, signInMcpServers } from "./integration-catalog.js";

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
          { kind: "mcp", source: "https://user:secret@code.example/mcp", auth: oauth },
          { kind: "mcp", source: "https://code.example/mcp#tools", auth: oauth },
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

describe("mcpSourcePresetsFor", () => {
  const ids = (webOrigin: string) => mcpSourcePresetsFor(webOrigin).map(({ id }) => id);

  it("offers a service that limits sign-in origins only where it signs in", () => {
    expect(ids("https://app.rakazo.com")).toContain("postiz");
    expect(ids("http://127.0.0.1:5173")).toContain("postiz");
    expect(ids("https://rakazo.self-hosted.example")).not.toContain("postiz");
    expect(ids("https://rakazo.self-hosted.example")).toContain("linear");
  });
});

describe("browseMcpPresets", () => {
  const presets = [
    { id: "a", name: "Tracker", featured: true },
    { id: "b", name: "Scheduler" },
  ];

  it("shows featured presets while browsing and any match while searching", () => {
    expect(browseMcpPresets(presets, " ").map(({ id }) => id)).toEqual(["a"]);
    expect(browseMcpPresets(presets, "sched").map(({ id }) => id)).toEqual(["b"]);
  });
});
