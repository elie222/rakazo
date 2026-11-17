import { once } from "node:events";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { connect, createServer as createTcpServer } from "node:net";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import type { TailnetDestination } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TailnetRoute } from "./tailnet-fetch.js";
import { createTailnetFetch, isTailnetUrl } from "./tailnet-fetch.js";
import { TAILNET_NOT_CONNECTED_MESSAGE } from "./tailnet-service.js";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function listen(server: Server | ReturnType<typeof createTcpServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as AddressInfo).port;
}

/** A node that dials every tailnet destination to one local port, recording where it was asked. */
function nodeTo(port: number): { route: TailnetRoute; dials: TailnetDestination[] } {
  const dials: TailnetDestination[] = [];
  const sockets: Socket[] = [];
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
  });
  return {
    dials,
    route: {
      async dial(destination) {
        dials.push(destination);
        const socket = connect(port, "127.0.0.1");
        sockets.push(socket);
        await once(socket, "connect");
        return socket;
      },
    },
  };
}

function fetchOver(route: TailnetRoute) {
  const tailnetFetch = createTailnetFetch(route);
  closers.push(() => tailnetFetch.close());
  return tailnetFetch;
}

describe("createTailnetFetch", () => {
  it("reaches a tailnet host over HTTP through the bot's node", async () => {
    // Capture Host and path out of band — never reflect request fields into the body.
    const seen: Array<{ host: string | undefined; url: string | undefined }> = [];
    const port = await listen(
      createServer((request, response) => {
        seen.push({ host: request.headers.host, url: request.url });
        response.writeHead(200, { "content-type": "text/plain" }).end("ok");
      }),
    );
    const { route, dials } = nodeTo(port);
    const tailnetFetch = fetchOver(route);

    const named = await tailnetFetch("http://nas.tail1234.ts.net:8080/mcp");
    expect(await named.text()).toBe("ok");
    const addressed = await tailnetFetch("http://100.101.102.103/mcp");
    expect(await addressed.text()).toBe("ok");
    expect(seen).toEqual([
      { host: "nas.tail1234.ts.net:8080", url: "/mcp" },
      { host: "100.101.102.103", url: "/mcp" },
    ]);
    expect(dials).toEqual([
      { host: "nas.tail1234.ts.net", port: 8080 },
      { host: "100.101.102.103", port: 80 },
    ]);
  });

  it("runs TLS from here, naming the tailnet host", async () => {
    let hello: Buffer | undefined;
    const port = await listen(
      createTcpServer((socket) =>
        socket.once("data", (chunk: Buffer) => {
          hello = chunk;
          socket.destroy();
        }),
      ),
    );
    const { route, dials } = nodeTo(port);

    await expect(fetchOver(route)("https://nas.tail1234.ts.net/mcp")).rejects.toThrow(
      "Could not reach nas.tail1234.ts.net",
    );
    expect(dials).toEqual([{ host: "nas.tail1234.ts.net", port: 443 }]);
    // A TLS handshake record whose ClientHello carries the name for SNI (uint16 length + bytes).
    expect(hello?.[0]).toBe(0x16);
    const sniHost = Buffer.from("nas.tail1234.ts.net");
    const lengthPrefixed = Buffer.alloc(2 + sniHost.length);
    lengthPrefixed.writeUInt16BE(sniHost.length, 0);
    sniHost.copy(lengthPrefixed, 2);
    expect(hello?.includes(lengthPrefixed)).toBe(true);
  });

  it("stops dialing once the request that wanted the connection is cancelled", async () => {
    let dialSignal: AbortSignal | undefined;
    const tailnetFetch = fetchOver({
      dial: (_destination, signal) => {
        dialSignal = signal;
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    });
    const request = new AbortController();
    const fetching = tailnetFetch("http://nas.tail1234.ts.net/mcp", { signal: request.signal });
    await vi.waitFor(() => expect(dialSignal).toBeDefined());
    expect(dialSignal?.aborted).toBe(false);
    request.abort();
    await expect(fetching).rejects.toThrow();
    expect(dialSignal?.aborted).toBe(true);
  });

  it("says why the tailnet refused", async () => {
    const tailnetFetch = fetchOver({
      dial: async () => {
        throw new PrivateNetworkError("permission", TAILNET_NOT_CONNECTED_MESSAGE);
      },
    });
    await expect(tailnetFetch("https://nas.tail1234.ts.net/mcp")).rejects.toThrow(
      `Could not reach nas.tail1234.ts.net: ${TAILNET_NOT_CONNECTED_MESSAGE}`,
    );
  });

  it("refuses hosts off the tailnet and redirects", async () => {
    const port = await listen(
      createServer((_request, response) =>
        response.writeHead(302, { location: "https://example.com/" }).end(),
      ),
    );
    const { route, dials } = nodeTo(port);
    const tailnetFetch = fetchOver(route);
    await expect(tailnetFetch("https://example.com/mcp")).rejects.toThrow("not on a tailnet");
    expect(dials).toEqual([]);
    await expect(tailnetFetch("http://nas.tail1234.ts.net/mcp")).rejects.toThrow(
      "redirects are not allowed",
    );
  });
});

describe("isTailnetUrl", () => {
  it.each([
    ["https://nas.tail1234.ts.net/mcp", true],
    ["http://100.101.102.103:3000/mcp", true],
    ["http://[fd7a:115c:a1e0::1]/mcp", true],
    ["https://ts.net/mcp", false],
    ["https://example.com/mcp", false],
    ["http://10.0.0.8/mcp", false],
    ["http://100.100.100.100/mcp", false],
  ])("%s → %s", (url, expected) => {
    expect(isTailnetUrl(new URL(url))).toBe(expected);
  });
});
