import { botInboundPath } from "@rakazo/contracts";

/** The full address a sender posts to, on the server this app talks to. */
export function botInboundUrl(botId: string, kind: "webhook" | "github"): string {
  const path = botInboundPath(botId, kind);
  return typeof window === "undefined" ? path : `${window.location.origin}${path}`;
}
