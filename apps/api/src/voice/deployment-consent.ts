import { aiRecipient } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { AI_DISCLOSURE_VERSION } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { DeploymentVoice } from "./deployment-config.js";

/** Shared disclosure identity for each operation's actual deployment endpoint. */
export function deploymentVoiceRecipients(
  deployment: DeploymentVoice,
  operations: { synthesize: boolean; transcribe: boolean },
) {
  const { provider, connection } = deployment;
  const recipients = [];
  if (operations.synthesize || (operations.transcribe && !connection.sttBaseUrl))
    recipients.push(aiRecipient({ provider, use: "voice", baseUrl: connection.baseUrl }));
  if (operations.transcribe && connection.sttBaseUrl)
    recipients.push(aiRecipient({ provider, use: "voice", baseUrl: connection.sttBaseUrl }));
  return recipients.filter((recipient) => recipient !== null);
}

/** Background speech may share data only with the recipients the owner already approved. */
export async function hasDeploymentVoiceConsent(
  prisma: Pick<PrismaClient, "aiDataConsent">,
  owner: Pick<Actor, "userId" | "spaceId">,
  deployment: DeploymentVoice,
  operations: { synthesize: boolean; transcribe: boolean },
): Promise<boolean> {
  const recipients = deploymentVoiceRecipients(deployment, operations);
  if (!recipients.length) return true;
  const consents = await prisma.aiDataConsent.findMany({
    where: {
      userId: owner.userId,
      spaceId: owner.spaceId,
      version: AI_DISCLOSURE_VERSION,
      recipientKey: { in: recipients.map((recipient) => recipient.key) },
    },
    select: { recipientKey: true },
  });
  const allowed = new Set(consents.map((consent) => consent.recipientKey));
  return recipients.every((recipient) => allowed.has(recipient.key));
}
