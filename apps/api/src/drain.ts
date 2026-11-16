import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/**
 * Asks a replaced API to stop taking requests and let the chat turns it is running end, for up
 * to RUN_DRAIN_MS, before it exits; SIGTERM hands them back at once. The image's
 * `org.rakazo.run-drain-signal` label names it, so the deploy sends it only to an API that
 * handles it.
 */
export const RUN_DRAIN_SIGNAL = "SIGUSR2";

const isStream = (request: IncomingMessage) =>
  request.headers.accept?.includes("text/event-stream") === true;

/**
 * Lets a replaced API finish its ordinary requests while streams and upgraded sockets close at
 * once, so clients reconnect to the new release instead of seeing a cut-off response.
 */
export function trackConnections(server: Server) {
  const sockets = new Set<Duplex>();
  const streams = new Set<Duplex>();
  const pending = new Set<ServerResponse>();
  let draining = false;
  const forget = (socket: Duplex) => {
    sockets.delete(socket);
    streams.delete(socket);
  };
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => forget(socket));
  });
  server.on("upgrade", (_request, socket: Duplex) => {
    streams.add(socket);
    if (draining) socket.destroy();
  });
  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    if (isStream(request)) {
      streams.add(request.socket);
      if (draining) request.socket.destroy();
      return;
    }
    if (draining) response.shouldKeepAlive = false;
    pending.add(response);
    response.once("close", () => pending.delete(response));
  });

  return async (graceMs: number) => {
    draining = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of streams) socket.destroy();
    for (const response of pending) if (!response.headersSent) response.shouldKeepAlive = false;
    const grace = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, graceMs);
    await closed;
    clearTimeout(grace);
  };
}
