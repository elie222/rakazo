import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { approvedModelCreditOffering, modelCreditOfferings } from "./model-credit-offerings.js";
import { modelProviderDefinition } from "./model-provider-registry.js";
import { parseModelSecret, secretValuesToRedact } from "./model-secret.js";
import { connectionModelSettings } from "./model-settings.js";

/** Only an operator allowlist may select a deployment-owned stored connection. */
export async function approvedModelCreditMaterial(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  provider: string,
  modelId: string,
) {
  if (!modelCreditOfferings()) return undefined;
  const offering = approvedModelCreditOffering(provider, modelId);
  if (!offering) throw new Error("This model requires a personal connection");
  if (!modelProviderDefinition(provider)) throw new Error("Unknown approved model provider");
  return runAsSystem("load approved model credit connection", async () => {
    const connection = await prisma.userModelCredential.findUnique({
      where: { id: offering.connectionId },
    });
    if (!connection || connection.provider !== provider)
      throw new Error("Approved model connection is unavailable");
    const stored = await prisma.secret.findFirst({
      where: { id: connection.secretId, userId: connection.userId, spaceId: null },
    });
    if (!stored) throw new Error("Approved model connection is unavailable");
    const secret = parseModelSecret(await secrets.load(stored.ciphertext, stored.id));
    // Custom endpoints and personal sign-ins never become credit-funded routes.
    if (secret.kind !== "api_key" || !secret.key.trim())
      throw new Error("Approved model connection requires an API key");
    const settings = connectionModelSettings(secret, provider, modelId, connection);
    return {
      apiKey: secret.key,
      contextWindow: settings.contextWindow,
      maxTokens: settings.maxTokens,
      reasoning: settings.reasoning,
      acceptsImages: settings.images,
      maxImagesPerPrompt: settings.maxImagesPerPrompt,
      cacheCapabilities: secret.cacheCapabilities,
      accountId: secret.accountId,
      gatewayId: secret.gatewayId,
      projectId: secret.projectId,
      region: secret.region,
      redact: secretValuesToRedact(secret),
    };
  });
}
