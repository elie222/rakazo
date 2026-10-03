import type { AiConsentStatus, AiDataUse, AiRecipient } from "@rakazo/contracts";
import { AI_CONSENT_REQUIRED } from "@rakazo/contracts";

/** A foreground check failed before the requested mutation was dispatched. */
export class AiConsentBlocked extends Error {
  constructor(message = AI_CONSENT_REQUIRED) {
    super(message);
  }
}

const pendingAiConsent = new Map<string, Promise<void>>();

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
  /** Separates independent API servers before the account-space scope is applied. */
  coalesceKey?: string;
}) {
  if (options.uses.length === 0) return;
  try {
    const status = await options.status();
    for (const recipient of status.recipients) {
      if (recipient.allowed || !options.uses.includes(recipient.use)) continue;
      const key = [options.coalesceKey ?? "", status.scope, status.version, recipient.key].join(
        "\u0000",
      );
      let pending = pendingAiConsent.get(key);
      if (!pending) {
        pending = (async () => {
          if (!(await options.prompt(recipient, status.privacyUrl)))
            throw new Error(AI_CONSENT_REQUIRED);
          await options.allow({
            scope: status.scope,
            version: status.version,
            keys: [recipient.key],
          });
        })().finally(() => {
          if (pendingAiConsent.get(key) === pending) pendingAiConsent.delete(key);
        });
        pendingAiConsent.set(key, pending);
      }
      await pending;
    }
  } catch (error) {
    throw new AiConsentBlocked(error instanceof Error ? error.message : AI_CONSENT_REQUIRED);
  }
}

export function aiConsentTarget(input: unknown): {
  botId?: string;
  groupId?: string;
  routineId?: string;
} {
  if (!input || typeof input !== "object") return {};
  const target = input as { botId?: unknown; groupId?: unknown; routineId?: unknown };
  const routineId = typeof target.routineId === "string" ? target.routineId : undefined;
  if (typeof target.groupId === "string") {
    return routineId ? { groupId: target.groupId, routineId } : { groupId: target.groupId };
  }
  if (typeof target.botId === "string") {
    return routineId ? { botId: target.botId, routineId } : { botId: target.botId };
  }
  return routineId ? { routineId } : {};
}
