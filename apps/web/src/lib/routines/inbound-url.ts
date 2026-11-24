import { botInboundUrl } from "@rakazo/contracts";
import { createContext, useContext } from "react";

const InboundOriginContext = createContext<string | undefined>(undefined);

/** The deployment's published inbound origin, from `me`, for the rows below it. */
export const InboundOriginProvider = InboundOriginContext.Provider;

/**
 * The full address a sender posts to: the deployment's published inbound origin when it has one,
 * else the server this app talks to.
 */
export function appBotInboundUrl(
  origin: string | undefined,
  botId: string,
  kind: "webhook" | "github",
): string {
  const base = origin ?? (typeof window === "undefined" ? "" : window.location.origin);
  return botInboundUrl(base, botId, kind);
}

/** The published inbound origin set by the nearest `InboundOriginProvider`. */
export function useInboundOrigin(): string | undefined {
  return useContext(InboundOriginContext);
}
