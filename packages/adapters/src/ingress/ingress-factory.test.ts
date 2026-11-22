import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIngressProvider, inboundOrigin, ingressPort } from "./ingress-factory.js";

describe("createIngressProvider", () => {
  it("publishes nothing unless a provider is chosen", () => {
    expect(createIngressProvider({})).toBeUndefined();
    expect(createIngressProvider({ INGRESS_PROVIDER: "none" })).toBeUndefined();
    expect(inboundOrigin({ API_URL: "https://app.internal.test" })).toBeUndefined();
  });

  it("takes the operator's own public origin", () => {
    expect(
      inboundOrigin({
        INGRESS_PROVIDER: "manual",
        INGRESS_PUBLIC_URL: "https://hooks.example.test/",
      }),
    ).toBe("https://hooks.example.test");
  });

  it.each([
    [{ INGRESS_PROVIDER: "manual" }],
    [{ INGRESS_PROVIDER: "manual", INGRESS_PUBLIC_URL: "http://hooks.example.test" }],
    [{ INGRESS_PROVIDER: "manual", INGRESS_PUBLIC_URL: "https://hooks.example.test/path" }],
    [{ INGRESS_PROVIDER: "tailscale", TAILSCALE_INGRESS_HOSTNAME: "hooks" }],
    [
      {
        INGRESS_PROVIDER: "tailscale",
        TAILSCALE_INGRESS_HOSTNAME: "hooks.app",
        TAILSCALE_INGRESS_TAILNET: "tail1234.ts.net",
      },
    ],
    [{ INGRESS_PROVIDER: "unknown" }],
  ])("refuses %j", (env) => {
    expect(() => createIngressProvider(env)).toThrow();
  });

  it("names the tailnet node's public origin from its own name", () => {
    expect(
      inboundOrigin({
        INGRESS_PROVIDER: "tailscale",
        TAILSCALE_INGRESS_HOSTNAME: "q7x2",
        TAILSCALE_INGRESS_TAILNET: "tail1234.ts.net.",
      }),
    ).toBe("https://q7x2.tail1234.ts.net");
  });

  it("writes a serve config that forwards only to the inbound listener, and clears it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ingress-"));
    const path = join(dir, "serve.json");
    const provider = createIngressProvider({
      INGRESS_PROVIDER: "tailscale",
      TAILSCALE_INGRESS_HOSTNAME: "q7x2",
      TAILSCALE_INGRESS_TAILNET: "tail1234.ts.net",
      TAILSCALE_INGRESS_SERVE_CONFIG: path,
    });
    const signal = new AbortController().signal;
    await provider?.publish("http://api:3101/ignored", signal);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder the node's container fills in.
    const host = "${TS_CERT_DOMAIN}:443";
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      TCP: { "443": { HTTPS: true } },
      Web: { [host]: { Handlers: { "/": { Proxy: "http://api:3101" } } } },
      AllowFunnel: { [host]: true },
    });
    await provider?.unpublish(signal);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({});
  });

  it("refuses to unpublish a tunnel it does not run", async () => {
    const provider = createIngressProvider({
      INGRESS_PROVIDER: "manual",
      INGRESS_PUBLIC_URL: "https://hooks.example.test",
    });
    await expect(provider?.unpublish(new AbortController().signal)).rejects.toThrow(
      "does not run this tunnel",
    );
  });

  it("reads the listener port", () => {
    expect(ingressPort({})).toBe(3101);
    expect(ingressPort({ INGRESS_PORT: "4000" })).toBe(4000);
    expect(() => ingressPort({ INGRESS_PORT: "0" })).toThrow();
  });
});
