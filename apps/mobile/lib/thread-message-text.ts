import { previewMessageText as previewText, resolvePersonaColorDef } from "@rakazo/core";
import type { MobileBot, MobileMessage, MobileSnapshot } from "./api";
import { t } from "./i18n";

export function previewMessageText(message: MobileMessage): string {
  return previewText(message, {
    photo: t("Photo"),
    attachment: t("Attachment"),
    message: t("Message"),
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
  return resolvePersonaColorDef(botId, raw).light;
}
