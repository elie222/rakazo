import type { MessagingInboundMessage, MessagingTeamRooms } from "@rakazo/adapter-kit";

/**
 * The team-room policy a mounted platform declares for itself, by provider id.
 * Echoes the descriptor the surface sends, so shared routing reads a capability
 * rather than naming a provider.
 */
export type TeamRoomPolicy = (provider: string) => MessagingTeamRooms | undefined;

/**
 * Whether a room the platform declares can still be a personally linked group.
 * A platform that says nothing is closed to linking: its rooms belong to the
 * deployment, so a link note there would be addressed to nobody.
 */
export function allowsPersonalLinking(provider: string, teamRooms: TeamRoomPolicy): boolean {
  return teamRooms(provider)?.personalLinking === true;
}

/**
 * Whether a message from a shared room belongs to the team-chat surface instead
 * of the personal group-linking one. A platform declares which of its rooms are
 * team rooms, and a room that exists only inside a workspace is one only there.
 */
export function prefersTeamChatSurface(
  event: Pick<MessagingInboundMessage, "provider" | "workspaceId" | "isDirect">,
  teamChatBotId: string | undefined | null,
  teamRooms: TeamRoomPolicy,
): boolean {
  if (event.isDirect || !teamChatBotId) return false;
  const rooms = teamRooms(event.provider);
  if (!rooms) return false;
  return !rooms.requiresWorkspace || Boolean(event.workspaceId);
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
