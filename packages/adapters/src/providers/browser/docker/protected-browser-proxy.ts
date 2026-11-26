import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { BlockList, connect } from "node:net";
import { networkInterfaces } from "node:os";
import { isCloudMetadataHost, isInternalHostname, isNonPublicAddress } from "@rakazo/contracts";

export function allowsProtectedBrowserAddresses(
  addresses: { address: string; family: number }[],
  interfaces = networkInterfaces(),
) {
  const local = new BlockList();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      local.addAddress(entry.address, entry.family === "IPv4" ? "ipv4" : "ipv6");
    }
  }
  return (
    addresses.length > 0 &&
    addresses.every(
      ({ address, family }) =>
        !isNonPublicAddress(address) && !local.check(address, family === 4 ? "ipv4" : "ipv6"),
    )
  );
}

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
      if (!allowsProtectedBrowserAddresses(addresses)) {
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
