import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { modelProviderDefinition } from "../models/model-provider-registry.js";
import { parseModelSecret, secretValuesToRedact } from "../models/model-secret.js";
import { connectionModelSettings } from "../models/model-settings.js";
import { modelAcceptsImageInput } from "../models/model-vision.js";
import type { CatalogReads } from "../runtime/pi/models/pi-live-catalog.js";
import { liveCatalogEntry, readOnce } from "../runtime/pi/models/pi-live-catalog.js";
import type { ModelCreditOffering } from "./offerings.js";
import { approvedModelCreditOffering, modelCreditOfferings } from "./offerings.js";

export class ModelCreditConnectionUnavailableError extends ClientError {
  constructor(message = "Approved model connection is unavailable") {
    super("BAD_REQUEST", message, "MODEL_CREDIT_CONNECTION_UNAVAILABLE");
  }
}

async function loadCreditConnection(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  offering: ModelCreditOffering,
  reads?: CatalogReads,
) {
  return readOnce(
    reads,
    `credit-connection:${JSON.stringify([offering.provider, offering.connectionId])}`,
    async () => {
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
        let plaintext: string;
        try {
          plaintext = await secrets.load(stored.ciphertext, stored.id);
        } catch (error) {
          getLogger().warn("approved model credit connection secret is unavailable", {
            offeringId: offering.id,
            provider: offering.provider,
          });
          if (error instanceof SecretStoreUnavailableError) throw error;
          throw new ModelCreditConnectionUnavailableError();
        }
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
    },
  );
}

/** Ready approved entries only; shared connections are read once per catalog request. */
export async function availableModelCreditOfferings(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  options: { offeringId?: string; providers?: ReadonlySet<string>; reads?: CatalogReads } = {},
) {
  const entries = (modelCreditOfferings()?.offerings ?? []).filter(
    (entry) =>
      (!options.offeringId || entry.id === options.offeringId) &&
      (!options.providers || options.providers.has(entry.provider)),
  );
  const reads = options.reads ?? new Map();
  const result = await Promise.all(
    entries.map(async (entry) => {
      try {
        await loadCreditConnection(prisma, secrets, entry, reads);
        return [entry];
      } catch (error) {
        if (
          error instanceof ModelCreditConnectionUnavailableError ||
          error instanceof SecretStoreUnavailableError
        )
          return [];
        throw error;
      }
    }),
  );
  return result.flat();
}

/** Recovery uses the reservation's original connection, including after an offering is withdrawn. */
export async function modelCreditUsageLookup(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  offering: ModelCreditOffering,
) {
  const create = modelProviderDefinition(offering.provider)?.usageLookup;
  if (!create) return undefined;
  const { secret } = await loadCreditConnection(prisma, secrets, offering);
  const lookup = create(secret.key);
  return {
    provider: lookup.provider,
    async lookupUsage(requestId: string) {
      try {
        return await lookup.lookupUsage(requestId);
      } catch {
        // Provider diagnostics may echo the stored key. The reconciler reports this safe error.
        throw new Error("Approved model usage lookup unavailable");
      }
    },
  };
}

/** Describe an approved live model using the same adapter fallback and settings as execution. */
export async function approvedModelCreditCatalogEntry(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  provider: string,
  modelId: string,
  reads?: CatalogReads,
) {
  const offering = approvedModelCreditOffering(provider, modelId);
  if (!offering) return undefined;
  const { connection, secret } = await loadCreditConnection(prisma, secrets, offering, reads);
  const settings = connectionModelSettings(secret, provider, modelId, connection);
  const entry = liveCatalogEntry(provider, modelId, settings);
  return entry
    ? {
        ...entry,
        ...(settings.contextWindow !== undefined ? { contextWindow: settings.contextWindow } : {}),
        ...(settings.maxTokens !== undefined ? { maxTokens: settings.maxTokens } : {}),
      }
    : undefined;
}

/** Only an operator allowlist may select a deployment-owned stored connection. */
export async function approvedModelCreditMaterial(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  provider: string,
  modelId: string,
  reads?: CatalogReads,
) {
  if (!modelCreditOfferings()) return undefined;
  const offering = approvedModelCreditOffering(provider, modelId);
  if (!offering)
    throw new ModelCreditConnectionUnavailableError("This model requires a personal connection");
  const { connection, secret } = await loadCreditConnection(prisma, secrets, offering, reads);
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

/** Describe the connection used by a credit-funded run without returning its key to callers. */
export async function approvedModelCreditSeesImages(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  provider: string,
  modelId: string,
  reads?: CatalogReads,
): Promise<boolean> {
  const material = await approvedModelCreditMaterial(prisma, secrets, provider, modelId, reads);
  return Boolean(material) && modelAcceptsImageInput(provider, modelId, material?.acceptsImages);
}
