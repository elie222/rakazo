import type { IdentityLabels } from "@rakazo/core";
import { t } from "./i18n";

export function identityLabels(): IdentityLabels {
  return {
    bot: t("Bot"),
    group: t("Group"),
    space: t("Space"),
    chats: t("Chats"),
    routine: t("Routine"),
    member: t("Member"),
    subagent: t("subagent"),
    owner: t("Owner"),
  };
}
