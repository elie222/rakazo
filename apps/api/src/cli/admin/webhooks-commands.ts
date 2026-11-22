import type { IngressProvider } from "@rakazo/adapter-kit";
import { createIngressProvider } from "@rakazo/adapters";
import { botInboundUrl } from "@rakazo/contracts";
import { deadlineSignal } from "@rakazo/core";
import type { AdminCommand, AdminResult } from "./admin-command.js";
import { AdminCommandError } from "./admin-command.js";

const PROBE_TIMEOUT_MS = 10_000;

export const webhooksCheckCommand: AdminCommand = {
  path: ["webhooks", "check"],
  usage: "",
  flags: [],
  parse: (args) => (args.length ? null : (context) => webhooksCheck(ingress(), context.signal)),
};

export const webhooksUnpublishCommand: AdminCommand = {
  path: ["webhooks", "unpublish"],
  usage: "",
  flags: [],
  parse: (args) =>
    args.length
      ? null
      : async (context) => {
          const provider = ingress();
          if (!provider.describe().canUnpublish) {
            throw new AdminCommandError(
              "Rakazo does not run this tunnel: stop it or its port forward yourself",
            );
          }
          await provider.unpublish(context.signal);
          return {
            text: `Unpublished ${provider.publicOrigin} until the API next starts. Unset INGRESS_PROVIDER to keep it off.`,
            json: { origin: provider.publicOrigin, published: false },
          };
        },
};

function ingress(): IngressProvider {
  const provider = createIngressProvider();
  if (!provider) throw new AdminCommandError("INGRESS_PROVIDER is not set: nothing is published");
  return provider;
}

/**
 * Prints the public address and whether a request through it reaches this instance: an unknown
 * bot's webhook answers 401 from the app, and any other path answers the ingress's own 404.
 */
export async function webhooksCheck(
  provider: IngressProvider,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<AdminResult> {
  const origin = provider.publicOrigin;
  const status = await provider
    .status(deadlineSignal(PROBE_TIMEOUT_MS, signal))
    .catch((error: unknown) => ({
      published: false as const,
      reason: error instanceof Error ? error.message : String(error),
    }));
  const probe = async (url: string, method: string) => {
    try {
      const response = await fetcher(url, {
        method,
        redirect: "manual",
        signal: deadlineSignal(PROBE_TIMEOUT_MS, signal),
      });
      return response.status;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const [webhook, other] = await Promise.all([
    probe(botInboundUrl(origin, "ingress-check", "webhook"), "POST"),
    probe(`${origin}/api/auth/capabilities`, "GET"),
  ]);
  const reaches = webhook === 401;
  const refuses = other === 404;
  const lines = [
    origin,
    `Provider: ${provider.describe().id}, ${status.published ? "published" : `not published (${status.reason})`}`,
    `Webhook route: ${reaches ? "reaches this instance" : `did not reach it (${webhook})`}`,
    `Other paths: ${refuses ? "refused" : `not refused (${other})`}`,
  ];
  const ok = status.published && reaches && refuses;
  if (!ok) throw new AdminCommandError(lines.join("\n"));
  return {
    text: lines.join("\n"),
    json: { origin, provider: provider.describe().id, published: true, reaches, refuses },
  };
}
