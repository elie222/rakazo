import type { IngressProvider } from "@rakazo/adapter-kit";
import { ManualIngressProvider } from "../providers/ingress/manual/manual-ingress.js";
import { TailscaleIngressProvider } from "../providers/ingress/tailscale/tailscale-ingress.js";

/** Where the inbound listener runs when INGRESS_PORT leaves it unset. */
export const DEFAULT_INGRESS_PORT = 3101;

/**
 * The provider that publishes this deployment's inbound routes, or undefined when INGRESS_PROVIDER
 * is unset: nothing is published unless the operator turns it on.
 */
export function createIngressProvider(
  env: NodeJS.ProcessEnv = process.env,
): IngressProvider | undefined {
  const kind = env.INGRESS_PROVIDER?.trim().toLowerCase();
  if (!kind || kind === "none") return undefined;
  if (kind === "manual") {
    const origin = env.INGRESS_PUBLIC_URL?.trim();
    if (!origin) throw new Error("INGRESS_PROVIDER=manual needs INGRESS_PUBLIC_URL");
    return new ManualIngressProvider(publicOrigin(origin));
  }
  if (kind === "tailscale") {
    const hostname = env.TAILSCALE_INGRESS_HOSTNAME?.trim().toLowerCase();
    const tailnet = env.TAILSCALE_INGRESS_TAILNET?.trim().toLowerCase().replace(/\.$/, "");
    if (!hostname || !tailnet) {
      throw new Error("This ingress provider needs TAILSCALE_INGRESS_HOSTNAME and _TAILNET");
    }
    return new TailscaleIngressProvider({
      hostname,
      tailnet,
      // The directory the bundled Compose service shares with the API.
      serveConfigPath: env.TAILSCALE_INGRESS_SERVE_CONFIG?.trim() || "/run/ingress/serve.json",
      socketPath: env.TAILSCALE_INGRESS_SOCKET?.trim() || "/run/ingress/tailscaled.sock",
    });
  }
  throw new Error(`Unknown ingress provider "${kind}"`);
}

/** The public origin outside services post to, when the deployment publishes one. */
export function inboundOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return createIngressProvider(env)?.publicOrigin;
}

/** The inbound listener's port, when an ingress provider is on. */
export function ingressPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INGRESS_PORT?.trim();
  const port = raw ? Number(raw) : DEFAULT_INGRESS_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("INGRESS_PORT must be a port number");
  }
  return port;
}

function publicOrigin(value: string): string {
  const url = URL.parse(value);
  if (url?.protocol !== "https:" || url.href !== `${url.origin}/`) {
    throw new Error("INGRESS_PUBLIC_URL must be an HTTPS origin, with no path");
  }
  return url.origin;
}
