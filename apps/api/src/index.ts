import type { Socket } from "node:net";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";

loadRootEnv();

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const { app, stop } = await createApp(env);
const server = serve({ fetch: app.fetch, port: env.port, hostname: env.apiHost }, () => {
  console.log(`rakazo api on http://${env.apiHost}:${env.port}`);
});

// Long-lived connections (threads.subscribe SSE streams) never end on their
// own, so server.close() alone waits forever for them. Track sockets and
// force-close any still open after a short grace period for in-flight
// requests, or every restart/shutdown hangs until something force-kills it.
const sockets = new Set<Socket>();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  const grace = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, 2_000);
  await closed;
  clearTimeout(grace);
  await stop();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
