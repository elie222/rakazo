import type { SecretStore } from "@rakazo/adapter-kit";
import type { SharedModelConnection, SharedModelInput } from "@rakazo/contracts";
import { ClientError, deadlineSignal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import * as z from "zod";
import { verifyModelServesAgents } from "./model-connect-check.js";
import { withModelCredentialLock } from "./model-credential-refresh.js";
import { modelProviderDefinition, modelProviders } from "./model-provider-registry.js";

export const SHARED_DEPLOYMENT_MODEL_RECORD = "deployment-model:default";
const modelSelect = {
  sharedModelProvider: true,
  sharedModelId: true,
  sharedModelMethod: true,
  sharedModelRevision: true,
  sharedModelCipher: true,
  sharedModelDisabled: true,
} as const;

type Row = {
  sharedModelProvider?: string | null;
  sharedModelId?: string | null;
  sharedModelMethod?: string | null;
  sharedModelRevision?: string | null;
  sharedModelCipher?: string | null;
  sharedModelDisabled?: boolean;
};

export type SharedDeploymentModel = SharedModelConnection & { revision: string };

const Binding = z.record(z.string(), z.object({ provider: z.string(), config: z.unknown() }));
const Access = z.object({ key: z.string().min(1), expiresAt: z.number() });
type Access = z.infer<typeof Access>;

function identityBindings() {
  try {
    return Binding.parse(JSON.parse(process.env.RAKAZO_MODEL_OAUTH_BINDINGS || "{}"));
  } catch {
    throw new ClientError("BAD_REQUEST", "Invalid deployment model OAuth bindings");
  }
}

export function sharedModelProviders() {
  const bindings = Object.entries(identityBindings());
  return Object.keys(modelProviders).flatMap((id) => {
    const provider = modelProviderDefinition(id);
    const methods: SharedModelConnection["method"][] = [];
    if (provider?.deployment || provider?.sharedApiKey) methods.push("api_key");
    const names = provider?.sharedOAuth
      ? bindings.filter(([, binding]) => binding.provider === id).map(([name]) => name)
      : [];
    if (names.length) methods.push("oauth");
    return methods.length ? [{ id, methods, bindings: names }] : [];
  });
}

export function sharedDeploymentModel(
  row: Row | null | undefined,
  enabled: boolean,
): SharedDeploymentModel | null {
  if (
    !enabled ||
    row?.sharedModelDisabled ||
    !row?.sharedModelProvider ||
    !row.sharedModelId ||
    !row.sharedModelRevision ||
    !row.sharedModelCipher ||
    (row.sharedModelMethod !== "api_key" && row.sharedModelMethod !== "oauth")
  )
    return null;
  return {
    provider: row.sharedModelProvider,
    modelId: row.sharedModelId,
    method: row.sharedModelMethod,
    revision: row.sharedModelRevision,
  };
}

async function exchange(provider: string, binding: string, signal: AbortSignal): Promise<Access> {
  const configured = Object.entries(identityBindings()).find(([name]) => name === binding)?.[1];
  const exchange = modelProviderDefinition(provider)?.sharedOAuth;
  if (!configured || configured.provider !== provider || !exchange)
    throw new ClientError("BAD_REQUEST", "Choose a configured OAuth binding for this provider");
  return Access.parse(await exchange(configured.config, signal));
}

export async function testSharedModel(input: SharedModelInput, signal?: AbortSignal) {
  const options = sharedModelProviders().find((entry) => entry.id === input.provider);
  if (!options?.methods.includes(input.method))
    throw new ClientError("BAD_REQUEST", "That provider does not support this shared connection");
  const checkSignal = deadlineSignal(20_000, signal);
  try {
    const key =
      input.method === "api_key"
        ? input.apiKey
        : (await exchange(input.provider, input.binding, checkSignal)).key;
    await verifyModelServesAgents(
      { provider: input.provider, id: input.modelId, apiKey: key },
      {
        signal: checkSignal,
        requireAccepted: true,
      },
    );
  } catch {
    signal?.throwIfAborted();
    throw new ClientError(
      "BAD_REQUEST",
      "Could not verify the model connection. Check the credential and model.",
    );
  }
}

// This grant exchanges an assertion instead of rotating a refresh token. Each worker may
// exchange independently, while its own concurrent calls share a short-lived token.
let cached: { revision: string; token: Access } | undefined;
function accessFor(model: SharedDeploymentModel, binding: string): Promise<Access> {
  return withModelCredentialLock(model.revision, async () => {
    if (cached?.revision === model.revision && cached.token.expiresAt - Date.now() > 30_000)
      return cached.token;
    const token = await exchange(model.provider, binding, AbortSignal.timeout(10_000));
    cached = { revision: model.revision, token };
    return token;
  });
}

export async function sharedModelRequestCredential(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  secrets: Pick<SecretStore, "load">,
  model: SharedDeploymentModel,
  registerSecrets?: (values: string[]) => void,
) {
  const current = () =>
    prisma.deploymentSettings.findUnique({ where: { id: "default" }, select: modelSelect });
  const revoked = () =>
    new ClientError("BAD_REQUEST", "The deployment model connection changed. Start a new run.");
  const row = await current();
  if (
    row?.sharedModelRevision !== model.revision ||
    row.sharedModelDisabled ||
    !row.sharedModelCipher
  )
    throw revoked();
  const value = await secrets.load(row.sharedModelCipher, SHARED_DEPLOYMENT_MODEL_RECORD);
  const key = model.method === "api_key" ? value : (await accessFor(model, value)).key;
  const latest = await current();
  if (latest?.sharedModelRevision !== model.revision || latest.sharedModelDisabled) throw revoked();
  registerSecrets?.([key]);
  return key;
}
