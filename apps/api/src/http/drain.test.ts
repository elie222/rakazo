import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_DRAIN_SIGNAL, trackConnections } from "./drain.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.closeAllConnections();
});

function start(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  servers.push(server);
  const drain = trackConnections(server);
  return new Promise<{ port: number; drain: typeof drain }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: (server.address() as AddressInfo).port, drain }),
    ),
  );
}

function get(port: number, accept?: string) {
  return new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const req = request({ port, host: "127.0.0.1", headers: accept ? { accept } : {} }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("trackConnections", () => {
  it("lets a slow request finish while a stream closes at once", async () => {
    let release = () => {};
    let arrived = 0;
    const { port, drain } = await start((req, res) => {
      arrived += 1;
      if (req.headers.accept === "text/event-stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: hello\n\n");
        return;
      }
      release = () => res.end("done");
    });
    const stream = get(port, "text/event-stream");
    const slow = get(port);
    await vi.waitFor(() => expect(arrived).toBe(2));

    const drained = drain(5_000);
    await expect(stream).rejects.toThrow();
    release();
    await expect(slow).resolves.toEqual({ status: 200, body: "done" });
    await drained;
  });

  it("cuts off requests still running when the grace period ends", async () => {
    let arrived = 0;
    const { port, drain } = await start(() => {
      arrived += 1;
    });
    const hung = get(port);
    await vi.waitFor(() => expect(arrived).toBe(1));

    await drain(100);
    await expect(hung).rejects.toThrow();
  });
});

describe("RUN_DRAIN_SIGNAL", () => {
  it("is the signal the app image tells the deploy to send", () => {
    const dockerfile = readFileSync(
      fileURLToPath(new URL("../../../../infra/compose/Dockerfile", import.meta.url)),
      "utf8",
    );
    expect(dockerfile).toContain(`LABEL org.rakazo.run-drain-signal=${RUN_DRAIN_SIGNAL}\n`);
  });
});
