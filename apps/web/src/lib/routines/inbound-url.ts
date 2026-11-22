/** Where a sender posts to start a bot's routines: its webhook or its Git events. */
export function botInboundUrl(botId: string, kind: "webhook" | "github"): string {
  const path = `/api/v1/bots/${botId}/${kind}`;
  return typeof window === "undefined" ? path : `${window.location.origin}${path}`;
}
