import type {
  BotSecretMetadata,
  VaultImportProblem,
  VaultKind,
  VaultPolicy,
} from "@rakazo/contracts";
import {
  BLOCKED_ITEM_ANSWER,
  hasAuthenticatorKey,
  hasVaultAccess,
  UNCHOSEN_ITEM_ANSWER,
} from "@rakazo/contracts";

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

/** Which of the owner's bots may use an item: every one, or those in `botIds`. */
export type VaultBots = { allBots: boolean; botIds: string[] };

/**
 * The Bots controls an item's editor shows, the same on web and mobile: which policies it offers,
 * whether bots are picked, and whether the note under them is said.
 */
export function vaultAccessControls(input: {
  kind: VaultKind;
  policy: VaultPolicy;
  /** Which bots may use it; left out when the server, or this Space, can't limit it to chosen bots. */
  access?: VaultBots;
  /** How many bots there are to choose from. */
  bots: number;
  /** Said under the bots when only some may use it, or when this Space's can't be chosen. */
  note?: string;
}): { policies: VaultPolicy[]; picker: boolean; note: string | undefined } {
  const { kind, policy, access, bots, note } = input;
  return {
    // Only a login asks first; another kind keeps Ask first only while it is set.
    policies: hasVaultAccess(kind)
      ? (["allow", "ask", "off"] as const).filter(
          (option) => option !== "ask" || kind === "login" || policy === "ask",
        )
      : [],
    // Blocked, no bot may use it at all; a Space without bots has nothing to choose from.
    picker: Boolean(access) && policy !== "off" && bots > 0,
    // Said when the choice is limited, or no choice can be made; a blocked item needs neither.
    note: note && policy !== "off" && !access?.allBots ? note : undefined,
  };
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
