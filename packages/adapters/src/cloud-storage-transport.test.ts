import { createServer } from "node:http";
// The hosted web provider loads jsdom, which installs its HTTP dispatcher.
import "jsdom";
import { expect, it, vi } from "vitest";
import { GatewayObjects } from "./cloud-storage.js";

it("uploads binary and empty objects with the hosted HTTP dispatcher", async () => {
  const received: Array<{ length: string | undefined; body: Buffer }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ length: request.headers["content-length"], body: Buffer.concat(chunks) });
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");
  const nativeFetch = globalThis.fetch;
  // Keep the real fetch/dispatcher; route only this test's gateway to loopback.
  vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) =>
    nativeFetch(`http://127.0.0.1:${address.port}/objects`, init),
  );
  try {
    const objects = new GatewayObjects("https://storage.example", "test-token".repeat(4));
    const content = Buffer.from("cloud ✓\u0000", "utf8");
    await objects.put("spaces/test/file", content);
    await objects.put("spaces/test/empty", new Uint8Array());
    expect(received).toEqual([
      { length: String(content.length), body: content },
      { length: "0", body: Buffer.alloc(0) },
    ]);
  } finally {
    vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
