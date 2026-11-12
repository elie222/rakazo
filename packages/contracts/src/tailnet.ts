import * as z from "zod";
import { isTailnetHost, normalizeHost } from "./network-host.js";

export { TAILNET_CONNECT_PATH } from "./tailnet-path.js";

/** The tag a space's bots join a tailnet with unless the admin picks another. */
export const TAILNET_DEFAULT_TAG = "tag:rakazo";

/** Tailscale tag names: `tag:` and a letter or digit, then letters, digits and hyphens. */
export const TailnetTagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^tag:[a-z0-9][a-z0-9-]{0,62}$/, "Use a tag such as tag:rakazo.");

/**
 * A tailnet admin's OAuth client (client credentials). It needs the `auth_keys` and
 * `devices:posture_attributes` scopes and must own `tag`.
 */
export const TailscaleConnectionConfigSchema = z.object({
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().trim().min(1).max(16384),
  tag: TailnetTagSchema.default(TAILNET_DEFAULT_TAG),
});
export type TailscaleConnectionConfig = z.infer<typeof TailscaleConnectionConfigSchema>;

/**
 * Tailnet access for the signed-in member in the current Space. `unavailable` says why this server
 * can't put bots on a tailnet: no Tailscale installed, or no address bots' computers can reach it
 * at. `connection` is the member's own, never another member's, and never holds the client.
 */
export const TailnetStatusSchema = z.object({
  unavailable: z.enum(["no_tailscale", "no_server_address"]).nullable(),
  connection: z.object({ tag: z.string(), botIds: z.array(z.string()) }).nullable(),
});
export type TailnetStatus = z.infer<typeof TailnetStatusSchema>;

export type TailnetDestination = { host: string; port: number };

/** `host:port` for a tailnet destination, with IPv6 bracketed. Used as its approval key. */
export function tailnetDestinationKey(destination: TailnetDestination): string {
  const host = destination.host.includes(":") ? `[${destination.host}]` : destination.host;
  return `${host}:${destination.port}`;
}

/** A normalized tailnet destination, or undefined when the host or port is not one. */
export function parseTailnetDestination(
  host: string,
  port: number | string,
): TailnetDestination | undefined {
  const normalized = normalizeHost(host);
  const portNumber = typeof port === "number" ? port : /^\d{1,5}$/.test(port) ? Number(port) : NaN;
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return undefined;
  if (!isTailnetHost(normalized)) return undefined;
  return { host: normalized, port: portNumber };
}

/**
 * The machine name a bot's node shows in the tailnet: `rakazo-<bot name>-<id suffix>`, one DNS
 * label. The suffix keeps two bots with the same name apart.
 */
export function tailnetNodeHostname(bot: { name: string; id: string }): string {
  const slug = bot.name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const suffix = bot.id
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-6);
  return ["rakazo", slug, suffix].filter(Boolean).join("-");
}

/** Tailscale posture attribute values: at most 50 letters, digits, underscores and periods. */
export function tailnetAttributeValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_.]/g, "_").slice(0, 50);
}

/** The custom posture attributes every bot node carries, for ACL rules. */
export function tailnetNodeAttributes(owner: {
  spaceId: string;
  botId: string;
  userId: string;
}): Record<string, string> {
  return {
    "custom:rakazoSpace": tailnetAttributeValue(owner.spaceId),
    "custom:rakazoBot": tailnetAttributeValue(owner.botId),
    "custom:rakazoUser": tailnetAttributeValue(owner.userId),
  };
}
