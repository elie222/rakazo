export type NotificationRoute =
  | {
      pathname: "/thread";
      params: { botId: string; threadId?: string; spaceId?: string; name?: string };
    }
  | {
      pathname: "/group-thread";
      params: { groupId: string; threadId?: string; spaceId?: string; name?: string };
    };

export type ThreadSpaceRequest =
  | { action: "show" }
  | { action: "switch"; spaceId: string }
  | { action: "unavailable" };

function singleRouteParam(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(value) && value.length === 1) return singleRouteParam(value[0]);
  return undefined;
}

function notificationField(data: Record<string, unknown>, key: string): string | undefined {
  const direct = data[key];
  const prefixed = data[`rakazo.${key}`];
  const value = typeof direct === "string" ? direct : prefixed;
  return typeof value === "string" ? singleRouteParam(value) : undefined;
}

/**
 * A bot and a group each have one thread. groupId wins when both are present
 * so a group run does not open that bot's direct chat.
 */
export function notificationOpenTarget(data: unknown): NotificationRoute | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const threadId = notificationField(record, "threadId");
  const spaceId = notificationField(record, "spaceId");
  const name = notificationField(record, "name");
  const shared = {
    ...(threadId ? { threadId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(name ? { name } : {}),
  };
  const groupId = notificationField(record, "groupId");
  if (groupId) return { pathname: "/group-thread", params: { groupId, ...shared } };
  const botId = notificationField(record, "botId");
  if (botId) return { pathname: "/thread", params: { botId, ...shared } };
  return null;
}

export function notificationOpenTargetFromLink(url: string): NotificationRoute | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "rakazo:") return null;
  const screen = (parsed.hostname || parsed.pathname.replace(/^\//, "")).replace(/\/$/, "");
  const data: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams) data[key] = value;
  if (screen === "thread") {
    delete data.groupId;
  } else if (screen === "group-thread") {
    delete data.botId;
  } else {
    return null;
  }
  return notificationOpenTarget(data);
}

export function notificationResponseRoute(
  response: {
    actionIdentifier: string;
    notification: { request: { content: { data?: unknown } } };
  },
  defaultActionIdentifier: string,
): NotificationRoute | null {
  if (response.actionIdentifier !== defaultActionIdentifier) return null;
  return notificationOpenTarget(response.notification.request.content.data);
}

export function threadSpaceRequest(
  spaceId: string | string[] | undefined,
  selectedSpaceId: string | null,
): ThreadSpaceRequest {
  if (spaceId === undefined) return { action: "show" };
  const requested = singleRouteParam(spaceId);
  if (!requested) return { action: "unavailable" };
  if (requested === selectedSpaceId) return { action: "show" };
  return { action: "switch", spaceId: requested };
}

export function threadSpaceSwitchResult(
  requestedSpaceId: string,
  switched: boolean,
  selectedSpaceId: string | null,
): "ready" | "failed" {
  return switched && selectedSpaceId === requestedSpaceId ? "ready" : "failed";
}

export type ThreadRouteFocus = {
  focused: boolean;
  appliedFocus: boolean;
  activeSpaceId: string | null;
  liveSpaceId: string | null;
  switchFailed: boolean;
};

/** When a covered thread route is shown again, follow the space selected now. */
export function threadRouteSpaceOnFocus(input: ThreadRouteFocus): ThreadRouteFocus {
  if (input.focused === input.appliedFocus) return input;
  if (!input.focused) return { ...input, appliedFocus: false };
  return {
    focused: true,
    appliedFocus: true,
    activeSpaceId: input.liveSpaceId,
    liveSpaceId: input.liveSpaceId,
    switchFailed: false,
  };
}
