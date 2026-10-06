import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AgentRunModel } from "@rakazo/adapter-kit";
import {
  CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE,
  cloudflareGatewayRouting,
  isCloudflareAiGatewayProvider,
} from "@rakazo/contracts";

const CLOUDFLARE_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID_ENV = "CLOUDFLARE_GATEWAY_ID";

/**
 * Pi reports this provider as unconfigured when a request carries only an API
 * key. The account and gateway ids are what fill the gateway base URL.
 */
export function cloudflareGatewayProviderEnv(
  model: Pick<AgentRunModel, "provider" | "accountId" | "gatewayId">,
): Record<string, string> | undefined {
  if (!isCloudflareAiGatewayProvider(model.provider)) return undefined;
  const routing = cloudflareGatewayRouting(model);
  if (!routing) throw new Error(CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE);
  return {
    [CLOUDFLARE_ACCOUNT_ID_ENV]: routing.accountId,
    [CLOUDFLARE_GATEWAY_ID_ENV]: routing.gatewayId,
  };
}

export function withCloudflareGatewayAuth(
  model: Pick<AgentRunModel, "provider" | "accountId" | "gatewayId">,
  options: ModelsSimpleStreamOptions | undefined,
): ModelsSimpleStreamOptions | undefined {
  const env = cloudflareGatewayProviderEnv(model);
  if (!env) return options;
  return { ...options, env: { ...options?.env, ...env } };
}
