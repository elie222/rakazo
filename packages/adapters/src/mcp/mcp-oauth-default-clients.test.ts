import { describe, expect, it } from "vitest";
import {
  defaultClientFor,
  defaultClientSecrets,
  deploymentClient,
  parseMcpOAuthDefaultClients,
} from "./mcp-oauth-default-clients.js";

describe("parseMcpOAuthDefaultClients", () => {
  it("reads nothing as no default clients", () => {
    expect(parseMcpOAuthDefaultClients(undefined)).toEqual({});
    expect(parseMcpOAuthDefaultClients("")).toEqual({});
    expect(parseMcpOAuthDefaultClients("  ")).toEqual({});
  });

  it("keys each client by its normalized issuer", () => {
    const clients = parseMcpOAuthDefaultClients(
      JSON.stringify({
        "https://issuer.example": {
          client_id: "client-1",
          client_secret: "secret-1",
          scope: "read write",
          authorization_params: "access_type=offline",
          servers: ["https://mcp.example.test/", "https://MCP2.example.test:443"],
        },
        "https://other.example/tenant": {
          client_id: "client-2",
          servers: ["https://mcp.example.test"],
        },
      }),
    );

    expect(clients).toEqual({
      "https://issuer.example/": {
        client_id: "client-1",
        client_secret: "secret-1",
        scope: "read write",
        authorization_params: "access_type=offline",
        servers: ["https://mcp.example.test", "https://mcp2.example.test"],
      },
      "https://other.example/tenant": {
        client_id: "client-2",
        servers: ["https://mcp.example.test"],
      },
    });
  });

  const entry = (fields: object) =>
    JSON.stringify({
      "https://issuer.example/": {
        client_id: "c",
        servers: ["https://mcp.example.test"],
        ...fields,
      },
    });

  it.each([
    ["malformed JSON", "{not json"],
    ["a JSON array", "[]"],
    ["a non-https issuer", '{"http://issuer.example/":{"client_id":"c"}}'],
    ["a key that is not a URL", '{"issuer":{"client_id":"c"}}'],
    ["an issuer with credentials", '{"https://user:pass@issuer.example/":{"client_id":"c"}}'],
    ["a missing client_id", entry({ client_id: undefined, client_secret: "s" })],
    ["an empty client_id", entry({ client_id: " " })],
    ["an unknown field", entry({ extra: 1 })],
    ["a reserved authorization parameter", entry({ authorization_params: "state=x" })],
    ["missing servers", entry({ servers: undefined })],
    ["empty servers", entry({ servers: [] })],
    ["servers that is not a list", entry({ servers: "https://mcp.example.test" })],
    ["a server that is not a URL", entry({ servers: ["mcp.example.test"] })],
    ["an http server", entry({ servers: ["http://mcp.example.test"] })],
    ["a server with credentials", entry({ servers: ["https://user:pass@mcp.example.test"] })],
    ["a server with a path", entry({ servers: ["https://mcp.example.test/mcp"] })],
    ["a server with a query", entry({ servers: ["https://mcp.example.test/?a=b"] })],
    ["a server with a fragment", entry({ servers: ["https://mcp.example.test/#a"] })],
    ["a wildcard server", entry({ servers: ["https://*.example.test"] })],
    [
      "the same issuer twice",
      '{"https://issuer.example":{"client_id":"a","servers":["https://m.example"]},"https://issuer.example/":{"client_id":"b","servers":["https://m.example"]}}',
    ],
  ])("refuses %s without echoing the value", (_name, raw) => {
    expect(() => parseMcpOAuthDefaultClients(raw)).toThrow(/^MCP_OAUTH_DEFAULT_CLIENTS /);
  });

  it("keeps a client secret out of its error", () => {
    expect(() => parseMcpOAuthDefaultClients(entry({ client_secret: "hunter2", bad: 1 }))).toThrow(
      /^(?!.*hunter2)/s,
    );
    expect(() =>
      parseMcpOAuthDefaultClients(
        entry({ client_secret: "hunter2", servers: ["https://u:hunter2@mcp.example.test"] }),
      ),
    ).toThrow(/^(?!.*hunter2)/s);
  });
});

describe("defaultClientFor", () => {
  const clients = parseMcpOAuthDefaultClients(
    '{"https://issuer.example":{"client_id":"c","servers":["https://mcp.example.test"]}}',
  );
  const expected = { client_id: "c", servers: ["https://mcp.example.test"] };
  const server = "https://mcp.example.test/mcp";

  it("matches the exact issuer only", () => {
    expect(defaultClientFor(clients, "https://issuer.example", server)).toEqual(expected);
    expect(defaultClientFor(clients, "https://issuer.example/", server)).toEqual(expected);
    expect(defaultClientFor(clients, "https://issuer.example/tenant", server)).toBeUndefined();
    expect(defaultClientFor(clients, "https://sub.issuer.example", server)).toBeUndefined();
    expect(defaultClientFor(clients, "http://issuer.example", server)).toBeUndefined();
    expect(defaultClientFor(clients, undefined, server)).toBeUndefined();
    expect(defaultClientFor(undefined, "https://issuer.example", server)).toBeUndefined();
  });

  it("matches only a listed MCP server origin", () => {
    expect(defaultClientFor(clients, "https://issuer.example", "https://mcp.example.test")).toEqual(
      expected,
    );
    for (const unlisted of [
      "https://other.example.test/mcp",
      "https://sub.mcp.example.test/mcp",
      "http://mcp.example.test/mcp",
      "https://mcp.example.test:8443/mcp",
      null,
      undefined,
    ])
      expect(defaultClientFor(clients, "https://issuer.example", unlisted)).toBeUndefined();
  });

  it("does not match inherited object keys", () => {
    expect(defaultClientFor(clients, "https://issuer.example/__proto__", server)).toBeUndefined();
  });
});

describe("defaultClientSecrets", () => {
  it("lists every configured secret", () => {
    const clients = parseMcpOAuthDefaultClients(
      JSON.stringify({
        "https://a.example": {
          client_id: "a",
          client_secret: "secret-a",
          servers: ["https://m.example"],
        },
        "https://b.example": { client_id: "b", servers: ["https://m.example"] },
      }),
    );

    expect(defaultClientSecrets(clients)).toEqual(["secret-a"]);
  });
});

describe("deploymentClient", () => {
  const clients = parseMcpOAuthDefaultClients(
    '{"https://issuer.example":{"client_id":"c","servers":["https://mcp.example.test"]}}',
  );
  const discovered = {
    oauth: { discoveryState: { authorizationServerUrl: "https://issuer.example" } },
  };
  const server = "https://mcp.example.test/mcp";

  it("applies when the user and the server registered no client", () => {
    expect(deploymentClient(discovered, clients, server)?.client_id).toBe("c");
  });

  it("yields to a client the user entered or the server registered", () => {
    expect(
      deploymentClient({ ...discovered, oauthClient: { client_id: "u" } }, clients, server),
    ).toBeUndefined();
    expect(
      deploymentClient(
        { oauth: { ...discovered.oauth, clientInformation: { client_id: "r" } } },
        clients,
        server,
      ),
    ).toBeUndefined();
  });

  it("never applies to a stdio server, which has no endpoint", () => {
    expect(deploymentClient(discovered, clients, null)).toBeUndefined();
  });
});
