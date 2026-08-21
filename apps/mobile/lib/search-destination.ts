import type { SearchHit } from "@rakazo/contracts";

export function mobileSearchDestination(hit: SearchHit):
  | {
      pathname: "/routine";
      params: { botId: string; botName: string; routineId: string };
    }
  | {
      pathname: "/thread";
      params: { botId: string; name: string; messageId?: string };
    } {
  if (hit.routineId) {
    return {
      pathname: "/routine",
      params: { botId: hit.botId, botName: hit.botName, routineId: hit.routineId },
    };
  }
  return {
    pathname: "/thread",
    params: {
      botId: hit.botId,
      name: hit.botName,
      ...(hit.messageId ? { messageId: hit.messageId } : {}),
    },
  };
}
