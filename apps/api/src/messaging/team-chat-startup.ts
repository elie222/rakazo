import type { MessagingInboundMessage } from "@rakazo/adapter-kit";

/**
 * Providers whose shared rooms are team-chat rooms rather than personal group
 * chats: one conversation per channel, with the bot in it as a teammate.
 */
const TEAM_CHAT_PROVIDERS = new Set(["slack", "discord", "teamchat-emulator"]);

/**
 * Whether a message from a shared room belongs to the team-chat surface instead
 * of the personal group-linking one. Slack rooms carry their workspace, and a
 * Discord room is only a team room inside a guild — a DM has no guild at all.
 */
export function prefersTeamChatSurface(
  event: Pick<MessagingInboundMessage, "provider" | "workspaceId" | "isDirect">,
  teamChatBotId: string | undefined | null,
): boolean {
  if (event.isDirect || !teamChatBotId) return false;
  if (!TEAM_CHAT_PROVIDERS.has(event.provider)) return false;
  return event.provider !== "discord" || Boolean(event.workspaceId);
}

export function settleWithTimeout(
  task: Promise<unknown> | undefined,
  timeoutMs: number,
): Promise<"done" | "timeout"> {
  if (!task) return Promise.resolve("done");
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task.then(
      () => "done" as const,
      () => "done" as const,
    ),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
