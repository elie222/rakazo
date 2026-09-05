import type { MessageBlock } from "@rakazo/contracts";
import { t } from "./i18n";

export type AppConnectBlock = Extract<MessageBlock, { kind: "app_connect" }>;

export function appConnectPresentation(block: AppConnectBlock, busy = false) {
  const connected = block.status === "connected";
  return {
    title: block.name,
    description: block.description,
    showAuthorize: !connected,
    actionLabel: connected ? t("Connected") : busy ? t("Waiting…") : t("Authorize"),
    connected,
  };
}
