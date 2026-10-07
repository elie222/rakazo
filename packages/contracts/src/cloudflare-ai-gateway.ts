/** Catalog id for the Cloudflare AI Gateway provider shipped by the model runtime. */
export const CLOUDFLARE_AI_GATEWAY_PROVIDER_ID = "cloudflare-ai-gateway";

/**
 * A key alone cannot route this provider. The runtime interpolates these ids
 * into the gateway base URL and refuses the provider when either is missing.
 */
export const CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE =
  "Cloudflare AI Gateway needs an account ID and a gateway ID.";

/** Ids are substituted into a URL path, so only a single path segment is accepted. */
const CLOUDFLARE_GATEWAY_ROUTING_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isCloudflareAiGatewayProvider(provider: string): boolean {
  return provider === CLOUDFLARE_AI_GATEWAY_PROVIDER_ID;
}

export function cloudflareGatewayRoutingId(value: string | null | undefined): string | undefined {
  const id = value?.trim() ?? "";
  return CLOUDFLARE_GATEWAY_ROUTING_ID.test(id) ? id : undefined;
}

export function cloudflareGatewayRouting(input: {
  accountId?: string | null;
  gatewayId?: string | null;
}): { accountId: string; gatewayId: string } | undefined {
  const accountId = cloudflareGatewayRoutingId(input.accountId);
  const gatewayId = cloudflareGatewayRoutingId(input.gatewayId);
  if (!accountId || !gatewayId) return undefined;
  return { accountId, gatewayId };
}
