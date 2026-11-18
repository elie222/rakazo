import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretNotFoundError, SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { SharedModelConnection, SharedModelInput } from "@rakazo/contracts";
import { ClientError, deadlineSignal, withAbort } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import * as z from "zod";
import { isPermanentDecryptFailure } from "../secrets/secrets.js";
import { verifyModelServesAgents } from "./model-connect-check.js";
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
export class SharedModelCredentialUnavailable extends Error {
  constructor(message = "The deployment model could not obtain an OAuth access token.") {
    super(message);
  }
}

const Access = z.object({ key: z.string().min(1), expiresAt: z.number() });
type Access = z.infer<typeof Access>;

function identityBindings() {
  try {
    return Binding.parse(JSON.parse(process.env.RAKAZO_MODEL_OAUTH_BINDINGS || "{}"));
  } catch {
    getLogger().warn("Ignoring invalid RAKAZO_MODEL_OAUTH_BINDINGS");
    return {};
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

export function sharedDeploymentModel(row: Row | null | undefined): SharedDeploymentModel | null {
  if (
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
  } catch (error) {
    signal?.throwIfAborted();
    if (checkSignal.aborted && error === checkSignal.reason)
      throw new ClientError("SERVICE_UNAVAILABLE", "The deployment model verification timed out.");
    if (error instanceof ClientError) throw error;
    throw new Error("Unexpected deployment model verification failure.");
  }
}

// This grant exchanges an assertion instead of rotating a refresh token. Each worker may
// exchange independently, while its own concurrent calls share a short-lived token.
let cached: { revision: string; token: Access } | undefined;
const exchanges = new Map<string, Promise<Access>>();

function accessFor(model: SharedDeploymentModel, binding: string): Promise<Access> {
  const { revision, provider } = model;
  if (cached?.revision === revision && cached.token.expiresAt - Date.now() > 30_000)
    return Promise.resolve(cached.token);
  const ongoing = exchanges.get(revision);
  if (ongoing) return ongoing;
  const deadline = deadlineSignal(10_000);
  const pending = withAbort(exchange(provider, binding, deadline), deadline)
    .then((token) => {
      cached = { revision, token };
      return token;
    })
    .catch((error: unknown) => {
      if (error instanceof ClientError || (deadline.aborted && error === deadline.reason))
        throw new SharedModelCredentialUnavailable();
      throw new Error("Unexpected deployment model OAuth exchange failure.");
    })
    .finally(() => exchanges.delete(revision));
  exchanges.set(revision, pending);
  return pending;
}

export async function sharedModelRequestCredential(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  secrets: Pick<SecretStore, "load">,
  model: SharedDeploymentModel,
  registerSecrets?: (values: string[]) => void,
  signal?: AbortSignal,
) {
  const wait = <T>(promise: Promise<T>) => (signal ? withAbort(promise, signal) : promise);
  const current = async () => {
    signal?.throwIfAborted();
    const row = await wait(
      prisma.deploymentSettings.findUnique({ where: { id: "default" }, select: modelSelect }),
    );
    if (
      row?.sharedModelRevision !== model.revision ||
      row.sharedModelDisabled ||
      !row.sharedModelCipher
    )
      throw new ClientError(
        "BAD_REQUEST",
        "The deployment model connection changed. Start a new run.",
      );
    return row.sharedModelCipher;
  };
  const cipher = await current();
  let key: string;
  try {
    const value = await wait(secrets.load(cipher, SHARED_DEPLOYMENT_MODEL_RECORD)).catch(
      (error: unknown) => {
        signal?.throwIfAborted();
        if (
          error instanceof SecretStoreUnavailableError ||
          error instanceof SecretNotFoundError ||
          isPermanentDecryptFailure(error)
        )
          throw new SharedModelCredentialUnavailable(
            "The deployment model credential could not be read.",
          );
        throw new Error("Unexpected deployment model credential read failure.");
      },
    );
    signal?.throwIfAborted();
    key = model.method === "api_key" ? value : (await wait(accessFor(model, value))).key;
  } catch (error) {
    // A revision that changed during a failed attempt must not fall through to a backup.
    await current();
    throw error;
  }
  await current();
  signal?.throwIfAborted();
  registerSecrets?.([key]);
  return key;
}
