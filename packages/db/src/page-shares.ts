import type { Prisma } from "./client.js";

/** A page link's sealed token: the secret row's id and the ref its secret store keeps it under. */
export type PageShareSecret = { id: string; ciphertext: string };

/**
 * A shared page keeps its link token sealed in a secret the page points to. Deleting pages any
 * way other than one at a time (their group going, for one) must delete those secrets first,
 * or the cascade leaves them behind with no page. Returns the deleted secrets, so that once the
 * transaction commits the caller can remove them from a remote secret store too.
 */
export async function deletePageShareSecrets(
  tx: Prisma.TransactionClient,
  pages: Prisma.PageWhereInput,
): Promise<PageShareSecret[]> {
  const where = { pageShare: { is: pages } };
  const secrets = await tx.secret.findMany({ where, select: { id: true, ciphertext: true } });
  await tx.secret.deleteMany({ where });
  return secrets;
}
