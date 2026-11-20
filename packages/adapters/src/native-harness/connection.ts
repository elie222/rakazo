import type { SandboxProvider, SecretStore } from "@rakazo/adapter-kit";
import { createAdapterContext, supportsComputerExecution } from "@rakazo/adapter-kit";
import type { ExecutionConnection, PrismaClient } from "@rakazo/db";
import { toComputerRef } from "./../computers/screens/computer-support.js";

export async function executionConnectionClient(
  secrets: SecretStore,
  connection: Pick<ExecutionConnection, "id" | "identity" | "secretRef" | "revokedAt">,
  sandbox?: SandboxProvider,
  prisma?: PrismaClient,
) {
  if (connection.revokedAt) throw new Error("execution_connection_revoked");
  const saved = JSON.parse(await secrets.load(connection.secretRef, connection.id)) as {
    computerId: string;
    spaceId: string;
    userId: string;
  };
  if (!supportsComputerExecution(sandbox) || !prisma)
    throw new Error("computer_execution_unavailable");
  const computer = await prisma.computer.findFirstOrThrow({
    where: { id: saved.computerId, spaceId: saved.spaceId, userId: saved.userId },
  });
  const client = await sandbox.execution(
    { ...toComputerRef(computer), id: computer.id },
    createAdapterContext(saved, "", "native-execution"),
    connection.identity,
  );
  if (!client) throw new Error("computer_execution_unavailable");
  return client;
}
