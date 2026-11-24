import type { ChatAlert } from "@rakazo/contracts";
import { rightPanelStorageKey } from "./right-panel-state";
import type { useRightPanel } from "./use-right-panel";

/** What opening a panel in a chat that may not be the open one needs. */
type ChatPanelDeps = {
  rightPanel: ReturnType<typeof useRightPanel>;
  userId: string | undefined;
  spaceId: string | undefined;
  navigate: (path: string) => void;
};

/** The saved panel state of that chat, so the panel opens there and not in the one on screen. */
function chatPanelKey(
  { userId, spaceId }: Pick<ChatPanelDeps, "userId" | "spaceId">,
  kind: "bot" | "group",
  id: string,
) {
  return userId && spaceId ? rightPanelStorageKey(userId, spaceId, kind, id) : null;
}

/** Opens a bot's or group's settings beside its chat. */
export function openSettingsInChat(
  kind: "bot" | "group",
  id: string,
  { rightPanel, userId, spaceId, navigate }: ChatPanelDeps,
) {
  rightPanel.openPanelInChat(
    chatPanelKey({ userId, spaceId }, kind, id),
    kind === "bot" ? "settings" : "group-settings",
    () => navigate(kind === "bot" ? `/app/${id}` : `/app/g/${id}`),
  );
}

/** Opens an alert's chat, and the thread it came from when it names one. */
export function openAlertChat(
  alert: Pick<ChatAlert, "botId" | "groupId" | "topicId">,
  { rightPanel, userId, spaceId, navigate }: ChatPanelDeps,
) {
  const path = alert.groupId ? `/app/g/${alert.groupId}` : `/app/${alert.botId}`;
  if (!alert.topicId || alert.groupId) return navigate(path);
  const destKey = chatPanelKey({ userId, spaceId }, "bot", alert.botId);
  rightPanel.openTopicInChat(destKey, { botId: alert.botId, topicId: alert.topicId }, () =>
    navigate(path),
  );
}
