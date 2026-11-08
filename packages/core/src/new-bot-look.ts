import type { BotAvatarSet } from "@rakazo/contracts";
import { BOT_COLORS, parseBotAvatarValue } from "@rakazo/contracts";
import {
  ORGANIC_AVATAR_HEART_FAMILY,
  ORGANIC_AVATAR_LOOKS,
  organicAvatarFamily,
  organicAvatarSampleIdentity,
} from "./avatar-shape.js";
import { newClientId } from "./client-id.js";

/** One preview identity per organic look, so a new bot can show a body before it has an id. */
export const ORGANIC_PREVIEW_IDENTITIES = ORGANIC_AVATAR_LOOKS.map(organicAvatarSampleIdentity);

function pick<T>(options: readonly T[]): T {
  return options[Math.floor(Math.random() * options.length)]!;
}

/** The look a bot being created starts with, before anyone picks. */
export interface NewBotLook {
  /** Reserved bot id; logo avatars draw from it, so creation keeps it. Never a heart body. */
  id: string;
  color: string;
  /** The organic body the preview draws. */
  identity: string;
}

export function newBotLook(): NewBotLook {
  let id: string;
  do {
    id = `c${newClientId().replaceAll("-", "").slice(0, 24)}`;
  } while (organicAvatarFamily(id) === ORGANIC_AVATAR_HEART_FAMILY);
  return { id, color: pick(BOT_COLORS), identity: pick(ORGANIC_PREVIEW_IDENTITIES) };
}

/** The identity the creation preview draws for the account's avatar set. */
export function newBotPreviewIdentity(avatarSet: BotAvatarSet, look: NewBotLook): string {
  return avatarSet === "rakazo" ? look.id : look.identity;
}

/** What `bots/create` needs so the new bot looks like its preview. */
export function newBotLookInput(
  avatarSet: BotAvatarSet,
  look: NewBotLook,
): { color: string; id?: string; avatarFamily?: number } {
  if (avatarSet === "rakazo") return { color: look.color, id: look.id };
  // A studio shape replaces the organic body, so the family would mean nothing.
  if (parseBotAvatarValue(look.color).kind === "shape") return { color: look.color };
  return { color: look.color, avatarFamily: organicAvatarFamily(look.identity) };
}
