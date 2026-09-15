import type { AiConsentStatus, AiDataUse, AiRecipient } from "@rakazo/contracts";
import { AI_CONSENT_REQUIRED } from "@rakazo/contracts";

/** A foreground check failed before the requested mutation was dispatched. */
export class AiConsentBlocked extends Error {
  constructor(message = AI_CONSENT_REQUIRED) {
    super(message);
  }
}

/** Only user actions that can start AI processing need a foreground disclosure. */
export function aiDataUsesForProcedure(procedure: string, input?: unknown): AiDataUse[] {
  const path = procedure.replaceAll(".", "/");
  if (
    path === "routines/update" &&
    input &&
    typeof input === "object" &&
    "active" in input &&
    input.active === false
  )
    return [];
  if (
    [
      "threads/send",
      "artifacts/create",
      "threads/followUp",
      "threads/react",
      "threads/answer",
      "routines/create",
      "routines/update",
      "routines/testRun",
    ].includes(path)
  )
    return ["model", "memory"];
  if (["voice/prepare", "voice/speak", "voice/transcribe"].includes(path)) return ["voice"];
  return [];
}

export async function ensureAiDataConsent(options: {
  uses: AiDataUse[];
  status(): Promise<AiConsentStatus>;
  prompt(recipient: AiRecipient, privacyUrl?: string): Promise<boolean>;
  allow(input: { scope: string; version: string; keys: string[] }): Promise<unknown>;
}) {
  if (options.uses.length === 0) return;
  try {
    const status = await options.status();
    for (const recipient of status.recipients) {
      if (recipient.allowed || !options.uses.includes(recipient.use)) continue;
      if (!(await options.prompt(recipient, status.privacyUrl)))
        throw new Error(AI_CONSENT_REQUIRED);
      await options.allow({ scope: status.scope, version: status.version, keys: [recipient.key] });
    }
  } catch (error) {
    throw new AiConsentBlocked(error instanceof Error ? error.message : AI_CONSENT_REQUIRED);
  }
}

export function aiConsentTarget(input: unknown): { botId?: string; groupId?: string } {
  if (!input || typeof input !== "object") return {};
  const target = input as { botId?: unknown; groupId?: unknown };
  if (typeof target.groupId === "string") return { groupId: target.groupId };
  return typeof target.botId === "string" ? { botId: target.botId } : {};
}
