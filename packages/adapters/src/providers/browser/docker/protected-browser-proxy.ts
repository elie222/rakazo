import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { isCloudMetadataHost, isInternalHostname, isNonPublicAddress } from "@rakazo/contracts";

export function createProtectedBrowserProxy() {
  const sockets = new Set<Socket>();
  function track(socket: Socket) {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  }

  const server = createServer({ maxHeaderSize: 4096 }, (_request, response) => {
    response.writeHead(403, { connection: "close" }).end();
  });
  server.maxConnections = 64;
  server.on("connection", track);
  server.on("connect", async (request, client, head) => {
    try {
      const authority = request.url ?? "";
      if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\]):443$/i.test(authority)) {
        throw new Error("Invalid tunnel destination");
      }
      const hostname = new URL(`https://${authority}`).hostname.replace(/^\[|\]$/g, "");
      if (isCloudMetadataHost(hostname) || isInternalHostname(hostname)) {
        throw new Error("Blocked tunnel destination");
      }
      const addresses = await lookup(hostname, { all: true });
      const local = Object.values(networkInterfaces()).flat();
      if (
        !addresses.length ||
        addresses.some(
          ({ address }) =>
            isNonPublicAddress(address) ||
            local.some((interfaceAddress) => interfaceAddress?.address === address),
        )
      ) {
        throw new Error("Blocked tunnel address");
      }
      if (client.destroyed) return;

      const target = addresses.find(({ family }) => family === 4) ?? addresses[0]!;
      const upstream = connect({ port: 443, host: target.address });
      track(upstream);
      upstream.once("close", () => client.destroy());
      client.once("close", () => upstream.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });

  return {
    server,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
