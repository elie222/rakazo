import { ORPCError } from "@orpc/server";
import type { EncryptedSecretStore } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { Prisma, type PrismaClient, withTransactionRetry } from "@rakazo/db";

type AgentSecretDeps = {
  prisma: PrismaClient;
  secrets: Pick<EncryptedSecretStore, "put">;
};

function agentSecretDto(row: { id: string; name: string; createdAt: Date; updatedAt: Date }) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function requireSpaceOwner(prisma: PrismaClient, actor: Actor): Promise<void> {
  const membership = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { role: true },
  });
  const roles = membership?.role.split(",").map((role) => role.trim());
  if (!roles?.includes("owner")) throw new ORPCError("FORBIDDEN");
}

export async function listAgentSecrets(deps: AgentSecretDeps, actor: Actor) {
  await requireSpaceOwner(deps.prisma, actor);
  const rows = await deps.prisma.agentSecret.findMany({
    where: { spaceId: actor.spaceId },
    orderBy: [{ name: "asc" }],
    select: { id: true, name: true, createdAt: true, updatedAt: true },
  });
  return rows.map(agentSecretDto);
}

export async function putAgentSecret(
  deps: AgentSecretDeps,
  actor: Actor,
  input: { name: string; value: string },
  signal = new AbortController().signal,
) {
  await requireSpaceOwner(deps.prisma, actor);
  const stored = await deps.secrets.put(input.value, {
    operationId: `agent-secret:${input.name}`,
    traceId: `agent-secret:${input.name}`,
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal,
  });

  const row = await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const existing = await tx.agentSecret.findUnique({
          where: { spaceId_name: { spaceId: actor.spaceId, name: input.name } },
          select: { secretId: true },
        });
        await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: actor.spaceId,
            kind: "agent-environment",
            ciphertext: stored.ciphertext,
          },
        });
        const updated = await tx.agentSecret.upsert({
          where: { spaceId_name: { spaceId: actor.spaceId, name: input.name } },
          create: {
            spaceId: actor.spaceId,
            createdByUserId: actor.userId,
            name: input.name,
            secretId: stored.id,
          },
          update: {
            createdByUserId: actor.userId,
            secretId: stored.id,
          },
        });
        if (existing && existing.secretId !== stored.id) {
          await tx.secret.deleteMany({
            where: { id: existing.secretId, spaceId: actor.spaceId },
          });
        }
        return updated;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return agentSecretDto(row);
}

export async function deleteAgentSecret(
  deps: AgentSecretDeps,
  actor: Actor,
  id: string,
): Promise<{ ok: true }> {
  await requireSpaceOwner(deps.prisma, actor);
  const existing = await deps.prisma.agentSecret.findFirst({
    where: { id, spaceId: actor.spaceId },
    select: { id: true, secretId: true },
  });
  if (!existing) throw new ORPCError("NOT_FOUND");

  await deps.prisma.$transaction(async (tx) => {
    await tx.agentSecret.delete({ where: { id: existing.id } });
    await tx.secret.deleteMany({
      where: { id: existing.secretId, spaceId: actor.spaceId },
    });
  });
  return { ok: true };
}
