import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE,
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  cloudflareGatewayProviderEnv,
  withCloudflareGatewayAuth,
} from "./cloudflare-ai-gateway.js";
import { buildModelConnectPlaintext } from "./model-connect.js";
import { parseModelSecret } from "./pi-oauth.js";

const ACCOUNT_ID = "acct1234";
const GATEWAY_ID = "gateway-1";
const API_KEY = "cf-test-key-value";

describe("Cloudflare AI Gateway auth", () => {
  it("resolves a saved credential into gateway auth and a routed base URL", async () => {
    const secret = parseModelSecret(
      buildModelConnectPlaintext({
        provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
        apiKey: API_KEY,
        accountId: ACCOUNT_ID,
        gatewayId: GATEWAY_ID,
      }),
    );
    expect(secret.kind).toBe("api_key");
    if (secret.kind !== "api_key") return;
    const modelConfig = {
      provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
      accountId: secret.accountId,
      gatewayId: secret.gatewayId,
    };
    const env = cloudflareGatewayProviderEnv(modelConfig);
    expect(withCloudflareGatewayAuth(modelConfig, { apiKey: API_KEY })?.env).toEqual(env);

    const models = builtinModels();
    const provider = models.getProvider(CLOUDFLARE_AI_GATEWAY_PROVIDER_ID);
    const model = provider?.getModels()[0];
    expect(model).toBeDefined();
    if (!model) return;

    const auth = await models.getAuth(model, { apiKey: API_KEY, env });
    expect(auth?.auth.headers?.["cf-aig-authorization"]).toBe(`Bearer ${API_KEY}`);

    let requestedUrl = "";
    let gatewayAuthorization: string | null = null;
    const stream = models.streamSimple(
      model,
      { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
      {
        apiKey: API_KEY,
        env,
        maxRetries: 0,
        fetch: async (input, init) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          const headers = new Headers(
            init?.headers ?? (input instanceof Request ? input.headers : undefined),
          );
          gatewayAuthorization = headers.get("cf-aig-authorization");
          return new Response("unauthorized", { status: 401 });
        },
      },
    );
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(requestedUrl).toContain(`/v1/${ACCOUNT_ID}/${GATEWAY_ID}/`);
    expect(requestedUrl).not.toContain("{CLOUDFLARE_");
    expect(gatewayAuthorization).toBe(`Bearer ${API_KEY}`);
  });

  it("classifies a gateway credential that cannot be routed", async () => {
    expect(() =>
      cloudflareGatewayProviderEnv({ provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID }),
    ).toThrow(CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE);
    expect(() =>
      cloudflareGatewayProviderEnv({
        provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
        accountId: "acct/secret",
        gatewayId: GATEWAY_ID,
      }),
    ).toThrow(CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE);

    const models = builtinModels();
    const model = models.getProvider(CLOUDFLARE_AI_GATEWAY_PROVIDER_ID)?.getModels()[0];
    expect(model).toBeDefined();
    if (!model) return;
    await expect(models.getAuth(model, { apiKey: API_KEY })).resolves.toBeUndefined();
    expect(CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE).not.toContain("Provider is not configured");
  });

  it("keeps saved routing ids ahead of caller env", () => {
    const model = {
      provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
      accountId: ACCOUNT_ID,
      gatewayId: GATEWAY_ID,
    };
    expect(
      withCloudflareGatewayAuth(model, {
        env: {
          CLOUDFLARE_ACCOUNT_ID: "other-account",
          CLOUDFLARE_GATEWAY_ID: "other-gateway",
          OTHER: "kept",
        },
      })?.env,
    ).toEqual({
      OTHER: "kept",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_GATEWAY_ID: GATEWAY_ID,
    });
  });

  it("leaves other providers unchanged", () => {
    const options = { apiKey: "sk-test-key-123" };
    expect(withCloudflareGatewayAuth({ provider: "openai" }, options)).toBe(options);
  });
});
