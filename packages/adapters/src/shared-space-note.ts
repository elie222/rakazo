import type { PrismaClient } from "@rakazo/db";
import { personSpeakerName } from "./history-speakers.js";
import { formatSharedSpaceNote } from "./run-instructions.prompt.js";

export async function loadSharedSpaceNote(
  prisma: Pick<PrismaClient, "spaceMember">,
  spaceId: string,
  requesterUserId: string,
): Promise<string | undefined> {
  const members = await prisma.spaceMember.findMany({
    where: { spaceId },
    select: { userId: true, member: { select: { user: { select: { name: true } } } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (members.length < 2) return undefined;
  const requester = members.find((member) => member.userId === requesterUserId);
  // The same names the history labels use, so the model can match them.
  return formatSharedSpaceNote(
    members.map((member) => personSpeakerName(member.member.user.name)),
    requester && personSpeakerName(requester.member.user.name),
  );
}
