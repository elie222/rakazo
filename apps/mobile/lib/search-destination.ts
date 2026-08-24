import type { SearchHit } from "@rakazo/contracts";

export function mobileSearchDestination(hit: SearchHit):
  | {
      pathname: "/routine";
      params: { botId: string; botName: string; routineId: string };
    }
  | {
      pathname: "/group-thread";
      params: { groupId: string; name: string; messageId?: string };
    }
  | {
      pathname: "/thread";
      params: { botId: string; name: string; messageId?: string };
    } {
  if (hit.routineId) {
    return {
      pathname: "/routine",
      params: { botId: hit.botId!, botName: hit.botName!, routineId: hit.routineId },
    };
  }
  if (hit.groupId) {
    return {
      pathname: "/group-thread",
      params: {
        groupId: hit.groupId,
        name: hit.groupName ?? hit.title,
        ...(hit.messageId ? { messageId: hit.messageId } : {}),
      },
    };
  }
  return {
    pathname: "/thread",
    params: {
      botId: hit.botId!,
      name: hit.botName ?? hit.title,
      ...(hit.messageId ? { messageId: hit.messageId } : {}),
    },
  };
}
