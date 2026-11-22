import { describe, expect, it } from "vitest";
import {
  defaultClientFor,
  defaultClientSecrets,
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
        },
        "https://other.example/tenant": { client_id: "client-2" },
      }),
    );

    expect(clients).toEqual({
      "https://issuer.example/": {
        client_id: "client-1",
        client_secret: "secret-1",
        scope: "read write",
        authorization_params: "access_type=offline",
      },
      "https://other.example/tenant": { client_id: "client-2" },
    });
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a JSON array", "[]"],
    ["a non-https issuer", '{"http://issuer.example/":{"client_id":"c"}}'],
    ["a key that is not a URL", '{"issuer":{"client_id":"c"}}'],
    ["an issuer with credentials", '{"https://user:pass@issuer.example/":{"client_id":"c"}}'],
    ["a missing client_id", '{"https://issuer.example/":{"client_secret":"s"}}'],
    ["an empty client_id", '{"https://issuer.example/":{"client_id":" "}}'],
    ["an unknown field", '{"https://issuer.example/":{"client_id":"c","extra":1}}'],
    [
      "a reserved authorization parameter",
      '{"https://issuer.example/":{"client_id":"c","authorization_params":"state=x"}}',
    ],
    [
      "the same issuer twice",
      '{"https://issuer.example":{"client_id":"a"},"https://issuer.example/":{"client_id":"b"}}',
    ],
  ])("refuses %s without echoing the value", (_name, raw) => {
    expect(() => parseMcpOAuthDefaultClients(raw)).toThrow(/^MCP_OAUTH_DEFAULT_CLIENTS /);
  });

  it("keeps a client secret out of its error", () => {
    const raw = '{"https://issuer.example/":{"client_id":"c","client_secret":"hunter2","bad":1}}';

    expect(() => parseMcpOAuthDefaultClients(raw)).toThrow(/^(?!.*hunter2)/s);
  });
});

describe("defaultClientFor", () => {
  const clients = parseMcpOAuthDefaultClients('{"https://issuer.example":{"client_id":"c"}}');

  it("matches the exact issuer only", () => {
    expect(defaultClientFor(clients, "https://issuer.example")).toEqual({
      client_id: "c",
    });
    expect(defaultClientFor(clients, "https://issuer.example/")).toEqual({
      client_id: "c",
    });
    expect(defaultClientFor(clients, "https://issuer.example/tenant")).toBeUndefined();
    expect(defaultClientFor(clients, "https://sub.issuer.example")).toBeUndefined();
    expect(defaultClientFor(clients, "http://issuer.example")).toBeUndefined();
    expect(defaultClientFor(clients, undefined)).toBeUndefined();
    expect(defaultClientFor(undefined, "https://issuer.example")).toBeUndefined();
  });

  it("does not match inherited object keys", () => {
    expect(defaultClientFor(clients, "https://issuer.example/__proto__")).toBeUndefined();
  });
});

describe("defaultClientSecrets", () => {
  it("lists every configured secret", () => {
    const clients = parseMcpOAuthDefaultClients(
      JSON.stringify({
        "https://a.example": { client_id: "a", client_secret: "secret-a" },
        "https://b.example": { client_id: "b" },
      }),
    );

    expect(defaultClientSecrets(clients)).toEqual(["secret-a"]);
  });
});
