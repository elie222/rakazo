import { t } from "@lingui/core/macro";
import {
  memberName,
  previewMessageText as previewText,
  resolvePersonaColorDef,
} from "@rakazo/core";
import type { MobileBot, MobileMessage, MobileSnapshot } from "./mobile-types";

export function previewMessageText(message: MobileMessage): string {
  return previewText(message, {
    photo: t`Photo`,
    attachment: t`Attachment`,
    message: t`Message`,
  });
}

/** Each bot keeps one identity color across web and mobile — same lookup as the avatar. */
export function speakerColorFor(
  bots: MobileBot[],
  members: MobileSnapshot["members"] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId) return undefined;
  const raw =
    bots.find((bot) => bot.id === botId)?.color ??
    members?.find((member) => member.botId === botId)?.color;
  return resolvePersonaColorDef(botId, raw).hex;
}

export function botDisplayName(
  members: MobileSnapshot["members"] | undefined,
  bots: MobileBot[],
  botId: string | undefined,
): string | undefined {
  return memberName(members, botId) ?? bots.find((bot) => bot.id === botId)?.name;
}
