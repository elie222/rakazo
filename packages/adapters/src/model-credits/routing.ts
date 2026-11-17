import type { SecretStore } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { modelProviderDefinition } from "../models/model-provider-registry.js";
import { parseModelSecret, secretValuesToRedact } from "../models/model-secret.js";
import { connectionModelSettings } from "../models/model-settings.js";
import type { ModelCreditOffering } from "./offerings.js";
import { approvedModelCreditOffering, modelCreditOfferings } from "./offerings.js";

class ModelCreditConnectionUnavailableError extends ClientError {
  constructor(message = "Approved model connection is unavailable") {
    super("BAD_REQUEST", message, "MODEL_CREDIT_CONNECTION_UNAVAILABLE");
  }
}

async function loadCreditConnection(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  offering: ModelCreditOffering,
) {
  if (!modelProviderDefinition(offering.provider))
    throw new ModelCreditConnectionUnavailableError("Unknown approved model provider");
  return runAsSystem("load approved model credit connection", async () => {
    const connection = await prisma.userModelCredential.findUnique({
      where: { id: offering.connectionId },
    });
    if (!connection || connection.provider !== offering.provider)
      throw new ModelCreditConnectionUnavailableError();
    const stored = await prisma.secret.findFirst({
      where: { id: connection.secretId, userId: connection.userId, spaceId: null },
    });
    if (!stored) throw new ModelCreditConnectionUnavailableError();
    const plaintext = await secrets.load(stored.ciphertext, stored.id);
    let secret: ReturnType<typeof parseModelSecret>;
    try {
      secret = parseModelSecret(plaintext);
    } catch {
      // Parser diagnostics can contain credential values; identify the offering only.
      getLogger().warn("approved model credit connection has an invalid stored secret", {
        offeringId: offering.id,
        provider: offering.provider,
      });
      throw new ModelCreditConnectionUnavailableError();
    }
    if (secret.kind !== "api_key" || !secret.key.trim())
      throw new ModelCreditConnectionUnavailableError(
        "Approved model connection requires an API key",
      );
    return { connection, secret };
  });
}

/** Ready approved entries only; shared connections are read once per catalog request. */
export async function availableModelCreditOfferings(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  offeringId?: string,
) {
  const entries = (modelCreditOfferings()?.offerings ?? []).filter(
    (entry) => !offeringId || entry.id === offeringId,
  );
  const ready = new Map<string, Promise<boolean>>();
  const result = await Promise.all(
    entries.map(async (entry) => {
      const key = JSON.stringify([entry.provider, entry.connectionId]);
      let check = ready.get(key);
      if (!check) {
        check = loadCreditConnection(prisma, secrets, entry).then(
          () => true,
          (error: unknown) => {
            if (error instanceof ModelCreditConnectionUnavailableError) return false;
            throw error;
          },
        );
        ready.set(key, check);
      }
      return (await check) ? [entry] : [];
    }),
  );
  return result.flat();
}

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
  const { connection, secret } = await loadCreditConnection(prisma, secrets, offering);
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
}
