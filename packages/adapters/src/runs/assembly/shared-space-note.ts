import type { PrismaClient } from "@rakazo/db";
import { personSpeakerName } from "../../runtime/context/history-speakers.js";
import { formatSharedSpaceNote } from "./run-instructions.prompt.js";

export async function loadSharedSpaceNote(
  prisma: Pick<PrismaClient, "spaceMember">,
  spaceId: string,
  requesterUserId: string,
  redact?: (text: string) => string,
): Promise<string | undefined> {
  const members = await prisma.spaceMember.findMany({
    where: { spaceId },
    select: { userId: true, member: { select: { user: { select: { name: true } } } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (members.length < 2) return undefined;
  const requester = members.find((member) => member.userId === requesterUserId);
  const safeName = (name: string) => personSpeakerName(redact ? redact(name) : name);
  // The same names the history labels use, so the model can match them.
  return formatSharedSpaceNote(
    members.map((member) => safeName(member.member.user.name)),
    requester && safeName(requester.member.user.name),
  );
}
