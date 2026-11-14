import type { Prisma } from "@rakazo/db";

/**
 * The API key behind a run's instructions, for the run or routine that run starts. A key's
 * instructions stay a key's however many runs they pass through.
 */
export async function promptCredentialOfRun(
  tx: Pick<Prisma.TransactionClient, "run">,
  runId: string,
): Promise<string | null> {
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: { promptCredentialId: true },
  });
  return run?.promptCredentialId ?? null;
}
