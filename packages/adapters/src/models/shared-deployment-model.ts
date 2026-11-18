import type { SecretStore } from "@rakazo/adapter-kit";
import {
  SecretNotFoundError,
  SecretStoreUnavailableError,
  SharedModelCredentialUnavailable,
} from "@rakazo/adapter-kit";
import type { SharedModelConnection, SharedModelInput } from "@rakazo/contracts";
import { SharedModelMethodSchema } from "@rakazo/contracts";
import { ClientError, deadlineSignal, withAbort } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import * as z from "zod";
import { isPermanentDecryptFailure } from "../secrets/secrets.js";
import { verifyModelServesAgents } from "./model-connect-check.js";
import { modelProviderDefinition, modelProviders } from "./model-provider-registry.js";

export const DEPLOYMENT_MODEL_CONNECTION_ID = "default";
export const DEPLOYMENT_MODEL_CONNECTION_PREFIX = "deployment:";
export const SHARED_DEPLOYMENT_MODEL_RECORD = "deployment-model:default";
const revisionSelect = { revision: true, disabled: true } as const;
type ModelStore = Pick<PrismaClient, "deploymentModelConnection">;

export type SharedDeploymentModel = SharedModelConnection & { revision: string };

const Binding = z.record(z.string(), z.object({ provider: z.string(), config: z.unknown() }));

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

export async function readSharedDeploymentModel(
  prisma: ModelStore,
): Promise<SharedDeploymentModel | null> {
  const row = await runAsSystem("read deployment model metadata", () =>
    prisma.deploymentModelConnection.findUnique({
      where: { id: DEPLOYMENT_MODEL_CONNECTION_ID },
      select: { provider: true, modelId: true, method: true, ...revisionSelect },
    }),
  );
  if (!row?.provider || !row.modelId || !row.revision || row.disabled) return null;
  const method = SharedModelMethodSchema.safeParse(row.method);
  return method.success
    ? { provider: row.provider, modelId: row.modelId, method: method.data, revision: row.revision }
    : null;
}

export function deploymentModelConnectionId(model: SharedDeploymentModel) {
  return `${DEPLOYMENT_MODEL_CONNECTION_PREFIX}${model.revision}`;
}

export function bindDeploymentModelCredential(
  prisma: ModelStore,
  secrets: Pick<SecretStore, "load">,
  model: SharedDeploymentModel,
) {
  return {
    connectionId: deploymentModelConnectionId(model),
    deploymentCredential: {
      resolve: (signal: AbortSignal) =>
        sharedModelRequestCredential(prisma, secrets, model, signal),
    },
  };
}

async function exchange(provider: string, binding: string, signal: AbortSignal): Promise<Access> {
  const bindings = identityBindings();
  const configured = Object.hasOwn(bindings, binding) ? bindings[binding] : undefined;
  const exchange = modelProviderDefinition(provider)?.sharedOAuth;
  if (!configured || configured.provider !== provider || !exchange)
    throw new ClientError("BAD_REQUEST", "Choose a configured OAuth binding for this provider");
  return Access.parse(await exchange(configured.config, signal));
}

export async function testSharedModel(
  input: SharedModelInput,
  signal?: AbortSignal,
  fetch?: typeof globalThis.fetch,
) {
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
        fetch,
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
  prisma: ModelStore,
  secrets: Pick<SecretStore, "load">,
  model: SharedDeploymentModel,
  signal?: AbortSignal,
) {
  const wait = <T>(promise: Promise<T>) => (signal ? withAbort(promise, signal) : promise);
  const authorizedCipher = async () => {
    signal?.throwIfAborted();
    const row = await wait(
      runAsSystem("authorize a deployment model dispatch", () =>
        prisma.deploymentModelConnection.findUnique({
          where: { id: DEPLOYMENT_MODEL_CONNECTION_ID },
          select: { ...revisionSelect, credentialCipher: true },
        }),
      ),
    );
    if (row?.revision !== model.revision || row.disabled || !row.credentialCipher)
      throw new ClientError(
        "BAD_REQUEST",
        "The deployment model connection changed. Start a new run.",
      );
    return row.credentialCipher;
  };
  const cipher = await authorizedCipher();
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
    return model.method === "api_key" ? value : (await wait(accessFor(model, value))).key;
  } finally {
    // Recheck even after a failure so a revocation cannot result in fallback.
    await authorizedCipher();
    signal?.throwIfAborted();
  }
}
