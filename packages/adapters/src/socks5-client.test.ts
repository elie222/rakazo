import { once } from "node:events";
import type { Server, Socket } from "node:net";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Socks5Error, socks5Connect } from "./socks5-client.js";

let server: Server | undefined;

/** A proxy that answers the greeting with `greeting` and the request with `onRequest`. */
async function proxy(
  onRequest: (client: Socket, request: Buffer) => void,
  greeting = Buffer.from([5, 0]),
): Promise<number> {
  server = createServer((client) => {
    client.once("data", () => {
      client.write(greeting);
      client.once("data", (request) => onRequest(client, request));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

function connectTo(port: number, signal = AbortSignal.timeout(5_000)) {
  return socks5Connect({
    proxy: { host: "127.0.0.1", port },
    host: "nas.tail1234.ts.net",
    port: 445,
    signal,
  });
}

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

describe("socks5Connect", () => {
  it("sends the name unresolved and keeps bytes that arrive with the reply", async () => {
    let request: Buffer | undefined;
    const port = await proxy((client, received) => {
      request = received;
      // A name-type bound address, then payload in the same chunk.
      client.write(
        Buffer.concat([
          Buffer.from([5, 0, 0, 3, 4]),
          Buffer.from("node"),
          Buffer.from([0, 80, 72, 105]),
        ]),
      );
    });
    const socket = await connectTo(port);
    const [data] = await once(socket.resume(), "data");
    expect(String(data)).toBe("Hi");
    socket.destroy();
    const name = Buffer.from("nas.tail1234.ts.net");
    expect(request).toEqual(
      Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([1, 189])]),
    );
  });

  it("reports the proxy's reason for refusing", async () => {
    const port = await proxy((client) => client.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])));
    const error = await connectTo(port).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Socks5Error);
    expect((error as Socks5Error).message).toBe("The connection found no route to the host.");
    expect((error as Socks5Error).reply).toBe(4);
  });

  it("refuses a proxy that wants authentication", async () => {
    const port = await proxy(() => {}, Buffer.from([5, 0xff]));
    await expect(connectTo(port)).rejects.toThrow("The tailnet proxy refused the handshake.");
  });

  it("stops waiting when cancelled", async () => {
    const port = await proxy(() => {});
    const controller = new AbortController();
    const pending = connectTo(port, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow("The connection was cancelled.");
  });

  it("explains an unreachable proxy", async () => {
    const port = await proxy(() => {});
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
    await expect(connectTo(port)).rejects.toThrow("The tailnet proxy could not be reached.");
  });
});
