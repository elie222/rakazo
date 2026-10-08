import type { SecretMigrationRepository, SecretMigrationRow } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";

const tables = ["secret", "botSecret", "integrationProviderConfig"] as const;

export function createSecretMigrationRepository(prisma: PrismaClient): SecretMigrationRepository {
  return {
    async *rows() {
      for (const label of tables) {
        let cursor: string | undefined;
        while (true) {
          const delegate = prisma[label];
          const batch = (await Reflect.apply(delegate.findMany, delegate, [
            {
              orderBy: { id: "asc" },
              take: 100,
              ...(cursor ? { where: { id: { gt: cursor } } } : {}),
            },
          ])) as Array<{ id: string; ciphertext: string; kind?: string }>;
          for (const row of batch)
            yield {
              id: row.id,
              label,
              ref: row.ciphertext,
              recordId:
                label === "integrationProviderConfig" ? `integration-provider:${row.id}` : row.id,
              ephemeral: row.kind?.startsWith("run-secret:"),
            };
          if (batch.length < 100) break;
          cursor = batch.at(-1)?.id;
        }
      }
    },
    async replace(row: SecretMigrationRow, ref: string) {
      const delegate = prisma[row.label as (typeof tables)[number]];
      const result = (await Reflect.apply(delegate.updateMany, delegate, [
        { where: { id: row.id, ciphertext: row.ref }, data: { ciphertext: ref } },
      ])) as { count: number };
      return result.count === 1;
    },
    async referenced(ref) {
      return Boolean(
        (await prisma.secret.count({ where: { ciphertext: ref } })) ||
          (await prisma.botSecret.count({ where: { ciphertext: ref } })) ||
          (await prisma.integrationProviderConfig.count({ where: { ciphertext: ref } })),
      );
    },
  };
}
