import { deferred } from "@rakazo/core/test-async";
import { expect, it, vi } from "vitest";
import { createMarketplaceConnectors } from "./marketplace-connectors.js";

const sha = "c".repeat(40);
const raw = `https://raw.githubusercontent.com/example/skills/${sha}/`;

/** A fake GitHub: the xAI registry lists one pinned plugin that brings a remote server. */
function reader() {
  const files: Record<string, string> = {
    "xai-org/plugin-marketplace/HEAD/.grok-plugin/marketplace.json": JSON.stringify({
      name: "xai",
      plugins: [
        {
          name: "cloud",
          description: "Cloud platform",
          source: { source: "url", url: "https://github.com/example/skills.git", sha },
        },
      ],
    }),
    "xai-org/plugin-marketplace/HEAD/.grok-plugin/plugin-index.json": JSON.stringify({
      version: 1,
      plugins: {
        cloud: {
          sha,
          components: {
            mcpServers: [{ name: "cloud", description: "http" }],
            skills: [{ name: "deploy", description: "Deploy" }],
          },
        },
      },
    }),
    "cursor/plugins/HEAD/.cursor-plugin/marketplace.json": JSON.stringify({ plugins: [] }),
    [`${raw}.cursor-plugin/plugin.json`.slice("https://raw.githubusercontent.com/".length)]:
      JSON.stringify({ name: "cloud" }),
    [`${raw}.mcp.json`.slice("https://raw.githubusercontent.com/".length)]: JSON.stringify({
      mcpServers: { cloud: { type: "http", url: "https://mcp.cloud.example.test/mcp" } },
    }),
  };
  return vi.fn(async (url: string) => {
    if (url.includes("api.github.com/repos/cursor/plugins/git/trees/"))
      return JSON.stringify({ tree: [] });
    const found = Object.entries(files).find(([path]) => url.endsWith(path));
    if (found) return found[1];
    throw new Error("Request failed: HTTP 404");
  });
}

/**
 * A fake network for the server's sign-in metadata. It points at an authorization server that
 * registers clients by itself, or one that only takes clients registered by hand.
 */
function signIn(registers: boolean, { challengeOnly = false } = {}) {
  const json = (body: unknown) => Response.json(body);
  return {
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    fetch: vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // Some servers name their metadata only in the challenge, at an address of their own.
      if (url.pathname === "/mcp")
        return new Response("unauthorized", {
          status: 401,
          headers: challengeOnly
            ? {
                // Unquoted, as some servers send it.
                "www-authenticate":
                  "Bearer resource_metadata=https://mcp.cloud.example.test/meta/resource",
              }
            : {},
        });
      if (
        challengeOnly
          ? url.pathname === "/meta/resource"
          : url.pathname.startsWith("/.well-known/oauth-protected-resource")
      )
        return json({
          resource: "https://mcp.cloud.example.test/mcp",
          authorization_servers: ["https://auth.cloud.example.test"],
        });
      if (url.hostname === "auth.cloud.example.test" && url.pathname.startsWith("/.well-known/"))
        return json({
          issuer: "https://auth.cloud.example.test",
          authorization_endpoint: "https://auth.cloud.example.test/authorize",
          token_endpoint: "https://auth.cloud.example.test/token",
          response_types_supported: ["code"],
          ...(registers
            ? { registration_endpoint: "https://auth.cloud.example.test/register" }
            : {}),
        });
      return new Response("not found", { status: 404 });
    }),
  };
}

it("reads a pinned plugin's server from its declaration files alone", async () => {
  const read = reader();
  // A full preview would fetch every skill; the declaration files are all it needs.
  const fetcher = vi.fn();
  const found = await createMarketplaceConnectors({ read, fetcher, network: signIn(true) }).find(
    "Cloud",
    new AbortController().signal,
  );
  expect(found).toEqual({
    name: "Cloud",
    description: "Cloud platform",
    logo: null,
    server: {
      name: "cloud",
      transport: "streamable_http",
      endpoint: "https://mcp.cloud.example.test/mcp",
      headers: {},
    },
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledWith(`${raw}.mcp.json`, 256_000, expect.any(AbortSignal));
});

it("finds nothing for a name no listing has", async () => {
  await expect(
    createMarketplaceConnectors({ read: reader() }).find("Elsewhere", new AbortController().signal),
  ).resolves.toBeNull();
});

it("offers no server whose sign-in needs a client registered by hand", async () => {
  await expect(
    createMarketplaceConnectors({ read: reader(), network: signIn(false) }).find(
      "Cloud",
      new AbortController().signal,
    ),
  ).resolves.toBeNull();
});

it("follows the server's challenge to its metadata before offering it", async () => {
  await expect(
    createMarketplaceConnectors({
      read: reader(),
      network: signIn(false, { challengeOnly: true }),
    }).find("Cloud", new AbortController().signal),
  ).resolves.toBeNull();
});

it("gives up on a server whose address lookup never answers once the run stops waiting", async () => {
  const lookupStarted = deferred();
  const run = new AbortController();
  const found = createMarketplaceConnectors({
    read: reader(),
    network: {
      ...signIn(true),
      resolveHostname: () => {
        lookupStarted.resolve();
        return new Promise(() => {});
      },
    },
  }).find("Cloud", run.signal);
  // The check's own deadline and the run's signal end it the same way, mid-lookup.
  await lookupStarted.promise;
  run.abort();
  await expect(found).rejects.toThrow();
});
