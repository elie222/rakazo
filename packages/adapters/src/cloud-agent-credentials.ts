import type { AdapterContext, CloudAgentProvider, SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { CloudAgentCredentialStatus } from "@rakazo/contracts";
import type { CloudAgent, CloudAgentCredential, PrismaClient } from "@rakazo/db";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import {
  cloudAgentProviderForKey,
  cloudAgentProviderKey,
  cloudAgentsEnabled,
} from "./cloud-agent-factory.js";
import { deleteSecretBestEffort } from "./secret-store-factory.js";

/** Statuses that no longer need the saved key. Matches the chat card. */
const TERMINAL_STATUSES = ["finished", "failed", "cancelled", "expired"] as const;

const DISCONNECTED: CloudAgentCredentialStatus = { status: "disconnected" };

export class CloudAgentCredentialRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudAgentCredentialRejected";
  }
}

/** Open agents still poll with this key, so it cannot be forgotten yet. */
export class CloudAgentCredentialBusy extends Error {
  constructor() {
    super("Cancel open cloud agents before disconnecting.");
    this.name = "CloudAgentCredentialBusy";
  }
}

export interface CloudAgentCredentialDeps {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "put" | "load" | "delete">;
  cloudAgent: CloudAgentConnection | null | undefined;
}

type Actor = { userId: string; spaceId: string };

function credentialId(userId: string): string {
  return `cloud-agent-credential:${userId}`;
}

function providerContext(actor: Actor, operation: string): AdapterContext {
  return {
    operationId: `cloud-agent-credential.${operation}`,
    traceId: `cloud-agent-credential.${operation}`,
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: AbortSignal.timeout(15_000),
  };
}

/** Blank, huge, or unusable as an environment value. */
export function cloudAgentApiKeyProblem(value: string): string | undefined {
  const key = value.trim();
  if (!key) return "Enter a key.";
  if (key.length > 4096 || key.includes("\0") || key.includes("\r") || key.includes("\n")) {
    return "That key cannot be used.";
  }
  return undefined;
}

async function currentRow(
  deps: CloudAgentCredentialDeps,
  userId: string,
): Promise<CloudAgentCredential | null> {
  const providerId = deps.cloudAgent?.userCredentialProviderId;
  if (!providerId) return null;
  const row = await deps.prisma.cloudAgentCredential.findUnique({ where: { userId } });
  return row?.provider === providerId ? row : null;
}

async function readApiKey(
  deps: CloudAgentCredentialDeps,
  row: Pick<CloudAgentCredential, "id" | "ciphertext">,
): Promise<string | null> {
  try {
    const value: unknown = JSON.parse(
      await deps.secretStore.load(row.ciphertext, { recordId: row.id }),
    );
    if (!value || typeof value !== "object") return null;
    const secret = (value as { secret?: unknown }).secret;
    return typeof secret === "string" && secret ? secret : null;
  } catch (error) {
    if (error instanceof SecretStoreUnavailableError) throw error;
    return null;
  }
}

function dropSecret(deps: CloudAgentCredentialDeps, rowId: string, ciphertext: string) {
  return deleteSecretBestEffort(deps.secretStore, ciphertext, { recordId: rowId });
}

/**
 * The key a launch, reply, or cancel would use now. A saved user key wins over the
 * deployment key. Null when this user cannot use cloud agents here.
 */
export async function activeCloudAgentBinding(
  deps: Pick<CloudAgentCredentialDeps, "prisma" | "cloudAgent">,
  userId: string,
  spaceId: string,
): Promise<{ providerKey: string } | null> {
  const connection = deps.cloudAgent;
  if (!connection) return null;
  if (connection.userCredentialProviderId) {
    const row = await deps.prisma.cloudAgentCredential.findUnique({ where: { userId } });
    if (row?.provider === connection.userCredentialProviderId)
      return { providerKey: row.providerKey };
  }
  if (connection.provider && cloudAgentsEnabled(connection, spaceId))
    return { providerKey: connection.key };
  return null;
}

/** Tools and the consent disclosure. Same choice as {@link activeCloudAgentBinding}. */
export async function cloudAgentToolsEnabled(
  prisma: PrismaClient,
  connection: CloudAgentConnection | null | undefined,
  userId: string,
  spaceId: string,
): Promise<boolean> {
  return Boolean(
    await activeCloudAgentBinding({ prisma, cloudAgent: connection }, userId, spaceId),
  );
}

/**
 * The provider that may call for this stored agent. A hash that matches neither the
 * deployment key nor this user's saved key returns null and makes no request.
 */
export async function cloudAgentCallerForStored(
  deps: CloudAgentCredentialDeps,
  agent: Pick<CloudAgent, "userId" | "spaceId" | "providerKey">,
): Promise<CloudAgentProvider | null> {
  const connection = deps.cloudAgent;
  if (!connection) return null;
  if (
    connection.provider &&
    agent.providerKey === connection.key &&
    cloudAgentsEnabled(connection, agent.spaceId)
  ) {
    return connection.provider;
  }
  if (!connection.userCredentialProviderId) return null;
  const row = await deps.prisma.cloudAgentCredential.findUnique({
    where: { userId: agent.userId },
  });
  if (
    !row ||
    row.provider !== connection.userCredentialProviderId ||
    row.providerKey !== agent.providerKey
  ) {
    return null;
  }
  const apiKey = await readApiKey(deps, row);
  if (!apiKey || cloudAgentProviderKey(apiKey) !== agent.providerKey) return null;
  return cloudAgentProviderForKey(apiKey);
}

/**
 * The CLI key is injected only on computers whose sessions live in a Unix home.
 * A desktop whose platform could not be read stays out: it may be Windows.
 */
export function cloudAgentCliOnComputer(computer: {
  kind: string;
  platform: string | undefined;
}): boolean {
  if (computer.kind === "wuying" || computer.platform === "win32") return false;
  if (computer.kind === "desktop") {
    return computer.platform === "darwin" || computer.platform === "linux";
  }
  return true;
}

/** The user's saved key for the computer CLI. The deployment key is never returned. */
export async function loadCloudAgentCliKey(
  deps: CloudAgentCredentialDeps,
  userId: string,
): Promise<string | null> {
  const row = await currentRow(deps, userId);
  if (!row) return null;
  const apiKey = await readApiKey(deps, row);
  if (!apiKey || cloudAgentProviderKey(apiKey) !== row.providerKey) return null;
  return apiKey;
}

/** Whether this user has a saved key the deployment still accepts. */
export async function userHasCloudAgentCredential(
  prisma: PrismaClient,
  userId: string,
  providerId: string | undefined,
): Promise<boolean> {
  if (!providerId) return false;
  const row = await prisma.cloudAgentCredential.findUnique({
    where: { userId },
    select: { provider: true },
  });
  return row?.provider === providerId;
}

function openCloudAgents(
  deps: CloudAgentCredentialDeps,
  userId: string,
  providerKey: string,
): Promise<number> {
  return deps.prisma.cloudAgent.count({
    where: { userId, providerKey, status: { notIn: [...TERMINAL_STATUSES] } },
  });
}

export async function cloudAgentCredentialStatus(
  deps: CloudAgentCredentialDeps,
  actor: Actor,
): Promise<CloudAgentCredentialStatus> {
  const row = await currentRow(deps, actor.userId);
  return row ? { status: "connected", connectedAt: row.updatedAt.toISOString() } : DISCONNECTED;
}

export async function connectCloudAgentCredential(
  deps: CloudAgentCredentialDeps,
  actor: Actor,
  apiKey: string,
): Promise<CloudAgentCredentialStatus> {
  const providerId = deps.cloudAgent?.userCredentialProviderId;
  if (!providerId) throw new CloudAgentCredentialRejected("Cloud agents are not configured.");
  const problem = cloudAgentApiKeyProblem(apiKey);
  if (problem) throw new CloudAgentCredentialRejected(problem);
  const key = apiKey.trim();
  const nextKey = cloudAgentProviderKey(key);
  const previous = await currentRow(deps, actor.userId);
  // Replacing the key orphans agents the worker can no longer cancel.
  if (
    previous &&
    previous.providerKey !== nextKey &&
    (await openCloudAgents(deps, actor.userId, previous.providerKey)) > 0
  ) {
    throw new CloudAgentCredentialBusy();
  }
  const id = credentialId(actor.userId);
  const ciphertext = await deps.secretStore.put(
    JSON.stringify({ secret: key }),
    providerContext(actor, "connect"),
    {
      recordId: id,
    },
  );
  try {
    const row = await deps.prisma.cloudAgentCredential.upsert({
      where: { userId: actor.userId },
      create: {
        id,
        userId: actor.userId,
        provider: providerId,
        providerKey: nextKey,
        ciphertext: ciphertext.ciphertext,
      },
      update: {
        provider: providerId,
        providerKey: nextKey,
        ciphertext: ciphertext.ciphertext,
      },
    });
    if (previous && previous.ciphertext !== row.ciphertext) {
      await dropSecret(deps, previous.id, previous.ciphertext);
    }
    return { status: "connected", connectedAt: row.updatedAt.toISOString() };
  } catch (error) {
    await dropSecret(deps, id, ciphertext.ciphertext);
    throw error;
  }
}

export async function disconnectCloudAgentCredential(
  deps: CloudAgentCredentialDeps,
  actor: Actor,
): Promise<CloudAgentCredentialStatus> {
  const row = await currentRow(deps, actor.userId);
  if (!row) return DISCONNECTED;
  if ((await openCloudAgents(deps, actor.userId, row.providerKey)) > 0) {
    throw new CloudAgentCredentialBusy();
  }
  const { count } = await deps.prisma.cloudAgentCredential.deleteMany({
    where: { id: row.id, ciphertext: row.ciphertext },
  });
  if (count) await dropSecret(deps, row.id, row.ciphertext);
  return DISCONNECTED;
}

/** Provider keys the reconciler should keep polling, besides the deployment key. */
export async function savedCloudAgentProviderKeys(
  prisma: PrismaClient,
  providerId: string | undefined,
): Promise<string[]> {
  if (!providerId) return [];
  const rows = await prisma.cloudAgentCredential.findMany({
    where: { provider: providerId },
    select: { providerKey: true },
  });
  return [...new Set(rows.map((row) => row.providerKey))];
}
