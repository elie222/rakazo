import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IngressProvider } from "@rakazo/adapter-kit";
import { afterAll, describe, expect, it } from "vitest";
import { createIngressProvider } from "./ingress-factory.js";

const dir = await mkdtemp(join(tmpdir(), "ingress-conformance-"));
const socketPath = join(dir, "local.sock");
// A stand-in for the node's local API: running, under the expected name, allowed to use Funnel.
const node = createServer((request, response) => {
  if (request.url !== "/localapi/v0/status") {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      BackendState: "Running",
      Self: { DNSName: "q7x2.tail1234.ts.net.", CapMap: { funnel: null, https: null } },
    }),
  );
});
await new Promise<void>((resolve) => node.listen(socketPath, resolve));
afterAll(() => new Promise<void>((resolve) => node.close(() => resolve())));

const providers: Record<string, IngressProvider | undefined> = {
  manual: createIngressProvider({
    INGRESS_PROVIDER: "manual",
    INGRESS_PUBLIC_URL: "https://hooks.example.test",
  }),
  tailscale: createIngressProvider({
    INGRESS_PROVIDER: "tailscale",
    TAILSCALE_INGRESS_HOSTNAME: "q7x2",
    TAILSCALE_INGRESS_TAILNET: "tail1234.ts.net",
    TAILSCALE_INGRESS_SERVE_CONFIG: join(dir, "serve.json"),
    TAILSCALE_INGRESS_SOCKET: socketPath,
  }),
};

describe.each(Object.entries(providers))("the %s ingress provider", (id, provider) => {
  const signal = new AbortController().signal;
  if (!provider) throw new Error(`${id} did not build`);

  it("describes itself and names an HTTPS origin with no path", () => {
    expect(provider.describe().id).toBe(id);
    const origin = new URL(provider.publicOrigin);
    expect(origin.protocol).toBe("https:");
    expect(`${origin.origin}`).toBe(provider.publicOrigin);
  });

  it("reports the address published once it publishes, and again on a repeat", async () => {
    await provider.publish("http://api:3101", signal);
    await provider.publish("http://api:3101", signal);
    await expect(provider.status(signal)).resolves.toEqual({ published: true });
  });

  it("unpublishes when it runs the tunnel, and refuses when the operator does", async () => {
    if (!provider.describe().canUnpublish) {
      await expect(provider.unpublish(signal)).rejects.toThrow();
      return;
    }
    await provider.unpublish(signal);
    await provider.unpublish(signal);
    await expect(provider.status(signal)).resolves.toMatchObject({ published: false });
  });
});
