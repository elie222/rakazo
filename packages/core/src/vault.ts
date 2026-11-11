import type { BotSecretMetadata, VaultImportProblem, VaultPolicy } from "@rakazo/contracts";
import { BLOCKED_ITEM_ANSWER, hasAuthenticatorKey, UNCHOSEN_ITEM_ANSWER } from "@rakazo/contracts";

/**
 * Which fixed refusal a secret answer's server error is. Its other errors could echo the value,
 * so they are never shown.
 */
export function secretAnswerRefusal(error: unknown): "blocked" | "unchosen" | undefined {
  const message = error && typeof error === "object" && "message" in error ? error.message : "";
  return message === BLOCKED_ITEM_ANSWER
    ? "blocked"
    : message === UNCHOSEN_ITEM_ANSWER
      ? "unchosen"
      : undefined;
}

export type VaultSaveDrop = "ask" | "block" | "bots" | "alsoOn" | "authenticatorKey";
export type VaultSaveSent = {
  policy?: VaultPolicy;
  allBots?: boolean;
  alsoOn?: string[];
  value?: string;
};

/** What a save asked for that an older server dropped silently, though the item is saved. */
export function vaultSaveDrops(
  sent: VaultSaveSent,
  saved: Partial<Pick<BotSecretMetadata, "policy" | "allBots" | "alsoOn" | "preview">>,
): VaultSaveDrop[] {
  const drops: VaultSaveDrop[] = [];
  // Allow is what a server without policies does anyway, so only Ask first and Block can be lost.
  if (sent.policy === "ask" && saved.policy !== "ask") drops.push("ask");
  else if (sent.policy === "off" && saved.policy === undefined) drops.push("block");
  if (sent.allBots === false && saved.allBots === undefined) drops.push("bots");
  if (sent.alsoOn && saved.alsoOn === undefined) drops.push("alsoOn");
  // A preview that couldn't be read says nothing of the key.
  if (hasAuthenticatorKey(sent.value) && saved.preview && !saved.preview.otp)
    drops.push("authenticatorKey");
  return drops;
}

// A short list: the counts already say how many, and a long export would bury the review.
const IMPORT_PROBLEMS_SHOWN = 5;

/** The left-out rows an import review lists, and how many more it only counts. */
export function vaultImportProblemList(problems: readonly VaultImportProblem[]): {
  shown: VaultImportProblem[];
  more: number;
} {
  return {
    shown: problems.slice(0, IMPORT_PROBLEMS_SHOWN),
    more: Math.max(0, problems.length - IMPORT_PROBLEMS_SHOWN),
  };
}
