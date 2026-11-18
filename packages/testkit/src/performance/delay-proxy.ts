import { once } from "node:events";
import { createServer, request as forward } from "node:http";
import type { AddressInfo } from "node:net";
import { abortableDelay } from "@rakazo/core";

/**
 * A loopback HTTP proxy that holds every request for `delayMs` before forwarding it, then
 * streams the answer back untouched, so a long-lived stream keeps working on a slow link.
 */
export async function startDelayProxy(input: {
  target: string;
  port: number;
  delayMs: number;
  hold?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}) {
  const target = new URL(input.target);
  const hold = input.hold ?? abortableDelay;
  const server = createServer((request, response) => {
    const gone = new AbortController();
    response.once("close", () => gone.abort());
    void hold(input.delayMs, gone.signal).then(
      () => {
        if (gone.signal.aborted) return;
        const upstream = forward(
          target,
          {
            method: request.method,
            path: request.url,
            headers: { ...request.headers, host: target.host },
          },
          (answer) => {
            response.writeHead(answer.statusCode ?? 502, answer.headers);
            // A reset API connection ends only this caller's response, never the proxy.
            answer.once("error", () => response.destroy());
            answer.pipe(response);
          },
        );
        gone.signal.addEventListener("abort", () => upstream.destroy());
        upstream.once("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        request.pipe(upstream);
      },
      () => response.destroy(),
    );
  });
  server.listen(input.port, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
