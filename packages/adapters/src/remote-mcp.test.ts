import { describe, expect, it } from "vitest";
import {
  assertSafeRemoteUrl,
  createSafeLookup,
  createSafeRemoteFetch,
  limitRemoteMcpPayload,
} from "./remote-mcp.js";

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

describe("remote MCP URL policy", () => {
  it("accepts public HTTPS endpoints", async () => {
    await expect(
      assertSafeRemoteUrl("https://connectors.example.test/mcp", publicResolver),
    ).resolves.toEqual(new URL("https://connectors.example.test/mcp"));
  });

  it("accepts hosts that resolve to a public IPv6 address", async () => {
    await expect(
      assertSafeRemoteUrl("https://connectors.example.test/mcp", async () => [
        { address: "2606:4700:4700::1111", family: 6 as const },
      ]),
    ).resolves.toEqual(new URL("https://connectors.example.test/mcp"));
  });

  it.each([
    "http://connectors.example.test/mcp",
    "https://localhost/mcp",
    "https://127.0.0.1/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://user:password@connectors.example.test/mcp",
    "https://[::1]/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
  ])("rejects unsafe endpoint %s", async (endpoint) => {
    await expect(assertSafeRemoteUrl(endpoint, publicResolver)).rejects.toThrow();
  });

  it("rejects a hostname that resolves privately", async () => {
    await expect(
      assertSafeRemoteUrl("https://connectors.example.test/mcp", async () => [
        { address: "10.1.2.3", family: 4 as const },
      ]),
    ).rejects.toThrow("private address");
  });

  it("allows Tailscale MagicDNS hosts that resolve to CGNAT addresses", async () => {
    const magicDns = "https://box.tail12345.ts.net/openapi.json";
    await expect(
      assertSafeRemoteUrl(magicDns, async () => [{ address: "100.64.1.2", family: 4 as const }]),
    ).resolves.toEqual(new URL(magicDns));

    const safeLookup = createSafeLookup(async () => [{ address: "100.119.57.55", family: 4 }]);
    const result = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
      safeLookup("box.tail12345.ts.net", { family: 0, all: false }, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: String(address), family });
      });
    });
    expect(result).toEqual({ address: "100.119.57.55", family: 4 });
  });

  it("allows the IPv6 half of a MagicDNS answer", async () => {
    // MagicDNS answers with the node's fd7a:115c:a1e0::/48 ULA alongside its
    // CGNAT address, so rejecting the ULA rejects every tailnet host.
    const magicDns = "https://box.tail12345.ts.net/mcp";
    const addresses = [
      { address: "fd7a:115c:a1e0:ab12:4843:cd96:6265:6667", family: 6 as const },
      { address: "100.64.1.2", family: 4 as const },
    ];
    await expect(assertSafeRemoteUrl(magicDns, async () => addresses)).resolves.toEqual(
      new URL(magicDns),
    );

    const safeLookup = createSafeLookup(async () => addresses);
    const resolved = await new Promise<unknown>((resolve, reject) => {
      safeLookup("box.tail12345.ts.net", { family: 0, all: true }, (error, entries) => {
        if (error) reject(error);
        else resolve(entries);
      });
    });
    expect(resolved).toEqual(addresses);
  });

  it("rejects non-Tailscale IPv6 private ranges for MagicDNS hosts", async () => {
    await expect(
      assertSafeRemoteUrl("https://box.tail12345.ts.net/mcp", async () => [
        { address: "fd00:1234::1", family: 6 as const },
      ]),
    ).rejects.toThrow("private address");
  });

  it("still rejects raw Tailscale CGNAT IP literals", async () => {
    await expect(
      assertSafeRemoteUrl("https://100.64.1.2/openapi.json", publicResolver),
    ).rejects.toThrow(/private host/i);
  });

  it("rejects MagicDNS hosts that resolve outside Tailscale CGNAT", async () => {
    await expect(
      assertSafeRemoteUrl("https://box.tail12345.ts.net/openapi.json", async () => [
        { address: "127.0.0.1", family: 4 as const },
      ]),
    ).rejects.toThrow("private address");
    await expect(
      assertSafeRemoteUrl("https://box.tail12345.ts.net/openapi.json", async () => [
        { address: "10.1.2.3", family: 4 as const },
      ]),
    ).rejects.toThrow("private address");
    await expect(
      assertSafeRemoteUrl("https://box.tail12345.ts.net/openapi.json", async () => [
        { address: "169.254.169.254", family: 4 as const },
      ]),
    ).rejects.toThrow("private address");
    await expect(
      assertSafeRemoteUrl("https://box.tail12345.ts.net/openapi.json", async () => [
        { address: "100.100.100.200", family: 4 as const },
      ]),
    ).rejects.toThrow("private address");
  });

  it("rejects private addresses in the lookup used by the network connection", async () => {
    const safeLookup = createSafeLookup(async () => [{ address: "10.1.2.3", family: 4 }]);
    const error = await new Promise<Error | null>((resolve) => {
      safeLookup("connectors.example.test", { family: 0, all: false }, (lookupError) => {
        resolve(lookupError);
      });
    });
    expect(error).toMatchObject({ message: "Connector URL resolves to a private address" });
  });

  it("returns the validated address directly to the network connection", async () => {
    const safeLookup = createSafeLookup(publicResolver);
    const result = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
      safeLookup("connectors.example.test", { family: 0, all: false }, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: String(address), family });
      });
    });
    expect(result).toEqual({ address: "203.0.113.10", family: 4 });
  });

  it("reports why a connection failed instead of a bare fetch failure", async () => {
    const cause = Object.assign(new Error("connect EHOSTUNREACH 100.64.1.2:443"), {
      code: "EHOSTUNREACH",
    });
    const safeFetch = createSafeRemoteFetch(async () => {
      throw new TypeError("fetch failed", { cause });
    }, publicResolver);
    try {
      await expect(safeFetch("https://connectors.example.test/mcp")).rejects.toThrow(
        "Could not reach connectors.example.test: connect EHOSTUNREACH 100.64.1.2:443",
      );
    } finally {
      await safeFetch.close();
    }
  });

  it("unwraps the per-address errors undici reports for dual-stack hosts", async () => {
    const safeFetch = createSafeRemoteFetch(async () => {
      throw new TypeError("fetch failed", {
        cause: new AggregateError(
          [new TypeError("fetch failed"), new Error("connect ECONNREFUSED 100.64.1.2:443")],
          "",
        ),
      });
    }, publicResolver);
    try {
      await expect(safeFetch("https://connectors.example.test/mcp")).rejects.toThrow(
        "connect ECONNREFUSED 100.64.1.2:443",
      );
    } finally {
      await safeFetch.close();
    }
  });

  it("drives the guarded dispatcher with a fetch from the same undici", async () => {
    // A fetch from a different undici than the Agent fails at dispatch with
    // "invalid onRequestStart method" before the lookup runs. Failing inside
    // the lookup proves the request reached the guarded Agent.
    let resolutions = 0;
    const safeFetch = createSafeRemoteFetch(undefined, async () => {
      resolutions += 1;
      if (resolutions > 1) throw new Error("lookup reached");
      return [{ address: "203.0.113.10", family: 4 as const }];
    });
    try {
      await expect(safeFetch("https://connectors.example.test/mcp")).rejects.toThrow(
        "Could not reach connectors.example.test: lookup reached",
      );
    } finally {
      await safeFetch.close();
    }
  });

  it("rejects Request inputs instead of silently dropping their method and body", async () => {
    const safeFetch = createSafeRemoteFetch(
      async () => new Response(null, { status: 204 }),
      publicResolver,
    );
    try {
      await expect(
        safeFetch(
          new Request("https://connectors.example.test/mcp", {
            method: "POST",
            body: "payload",
          }),
        ),
      ).rejects.toThrow("requires a URL");
    } finally {
      await safeFetch.close();
    }
  });
});

describe("remote MCP result limits", () => {
  it("applies the result budget in UTF-8 bytes instead of JavaScript characters", () => {
    const value = { content: "界".repeat(400_000) };
    const limited = limitRemoteMcpPayload(value) as { truncated: boolean; content: string };

    expect(limited.truncated).toBe(true);
    expect(Buffer.byteLength(limited.content, "utf8")).toBeLessThanOrEqual(1_000_000);
    expect(limited.content).not.toContain("\uFFFD");
  });
});
