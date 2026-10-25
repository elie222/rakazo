import type { ModelBackupChoice } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

/** The previous release's copy of the main model's fallbacks; the caller holds the write. */
export async function writeSpaceBackupModels(
  prisma: Pick<PrismaClient, "spaceBackupModel">,
  scope: { userId: string; spaceId: string },
  models: ModelBackupChoice[],
): Promise<void> {
  const scoped = { userId: scope.userId, spaceId: scope.spaceId };
  await prisma.spaceBackupModel.deleteMany({ where: scoped });
  if (models.length)
    await prisma.spaceBackupModel.createMany({
      data: models.map((model, position) => ({ ...scoped, ...model, position })),
    });
}
