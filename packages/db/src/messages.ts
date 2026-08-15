import type { MessageBlock } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";

export async function createThreadMessage(
  prisma: PrismaClient,
  input: {
    threadId: string;
    role: "user" | "bot" | "system";
    blocks: MessageBlock[];
    runId?: string;
  },
) {
  return prisma.$transaction(async (tx) => {
    const thread = await tx.thread.update({
      where: { id: input.threadId },
      data: { nextMessageSeq: { increment: 1 } },
      select: { nextMessageSeq: true },
    });
    return tx.message.create({
      data: {
        threadId: input.threadId,
        seq: thread.nextMessageSeq - 1,
        role: input.role,
        blocks: input.blocks as Prisma.InputJsonValue,
        runId: input.runId,
      },
    });
  });
}
