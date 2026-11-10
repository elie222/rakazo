import { Trans, useLingui } from "@lingui/react/macro";
import type { Space } from "@rakazo/contracts";
import { snoozeWakeDay } from "@rakazo/core";
import { BotAvatar, Button, GroupAvatar } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { SidebarShelf } from "./sidebar-shelf";
import type { SnoozeChat, ToggleChat } from "./use-chat-snooze";

export type ShelvedChat =
  | { kind: "bot"; chat: Space["bots"][number] }
  | { kind: "group"; chat: Space["groups"][number] };

/** The bots, then the groups, across every space that `keep` puts on a shelf. */
export function shelvedChats(
  spaces: readonly Pick<Space, "bots" | "groups">[],
  keep: (chat: ShelvedChat["chat"]) => boolean,
): ShelvedChat[] {
  return spaces.flatMap((space) => [
    ...space.bots.filter(keep).map((chat) => ({ kind: "bot" as const, chat })),
    ...space.groups.filter(keep).map((chat) => ({ kind: "group" as const, chat })),
  ]);
}

/**
 * Chats set aside from every listed space, folded at the bottom of the sidebar. Each opens on
 * click and offers, on hover or focus, the one action that puts it back in the list.
 */
function ChatShelf({
  title,
  chats,
  showSpaceSearch,
  detail,
  action,
  actionLabel,
  onAction,
  openSpaceChat,
}: {
  title: ReactNode;
  chats: ShelvedChat[];
  showSpaceSearch: boolean;
  /** A short note at the end of the row, hidden while the action shows. */
  detail?: (chat: ShelvedChat["chat"]) => ReactNode;
  action: ReactNode;
  actionLabel: (chat: ShelvedChat["chat"]) => string;
  onAction: (item: ShelvedChat) => void;
  openSpaceChat: (spaceId: string, path: string) => void;
}) {
  if (chats.length === 0 || showSpaceSearch) return null;
  return (
    <SidebarShelf title={title} count={chats.length}>
      {chats.map((item) => {
        const { kind, chat } = item;
        return (
          <div
            key={`${kind}:${chat.id}`}
            className="group/shelf flex items-center gap-2 rounded-lg px-2.5 py-1 hover:bg-sidebar-accent"
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-start"
              onClick={() =>
                openSpaceChat(
                  chat.spaceId,
                  kind === "bot" ? `/app/${chat.id}` : `/app/g/${chat.id}`,
                )
              }
            >
              {kind === "bot" ? (
                <BotAvatar
                  avatarSet={chat.avatarSet}
                  color={chat.color}
                  identity={chat.id}
                  size={28}
                  status={chat.status}
                />
              ) : (
                <GroupAvatar members={chat.members} size={28} />
              )}
              <span className="min-w-0 flex-1 truncate text-body text-foreground/75" dir="auto">
                {chat.name}
              </span>
              {detail ? (
                <span className="shrink-0 text-label text-faint-foreground tabular-nums group-focus-within/shelf:hidden group-hover/shelf:hidden">
                  {detail(chat)}
                </span>
              ) : null}
            </button>
            <Button
              variant="ghost"
              size="xs"
              className="sr-only focus-visible:not-sr-only group-hover/shelf:not-sr-only"
              aria-label={actionLabel(chat)}
              onClick={() => onAction(item)}
            >
              {action}
            </Button>
          </div>
        );
      })}
    </SidebarShelf>
  );
}

/** Snoozed chats with their wake times. */
export function SnoozedChats({
  snoozed,
  now,
  snooze,
  ...shelf
}: {
  snoozed: ShelvedChat[];
  showSpaceSearch: boolean;
  now: number;
  snooze: SnoozeChat;
  openSpaceChat: (spaceId: string, path: string) => void;
}) {
  const { t, i18n } = useLingui();
  return (
    <ChatShelf
      {...shelf}
      title={<Trans>Snoozed</Trans>}
      chats={snoozed}
      detail={(chat) => {
        const wake = new Date(chat.snoozedUntil ?? "");
        const day = snoozeWakeDay(wake, new Date(now));
        return i18n.date(wake, { ...day, hour: "numeric", minute: "2-digit" });
      }}
      action={<Trans>Unsnooze</Trans>}
      actionLabel={(chat) => t`Unsnooze ${chat.name}`}
      onAction={({ kind, chat }) => snooze({ kind, ...chat }, null)}
    />
  );
}

/** Chats hidden from the list; they keep working, and come back by themselves when they need the viewer. */
export function HiddenChats({
  hidden,
  hide,
  ...shelf
}: {
  hidden: ShelvedChat[];
  showSpaceSearch: boolean;
  hide: ToggleChat;
  openSpaceChat: (spaceId: string, path: string) => void;
}) {
  const { t } = useLingui();
  return (
    <ChatShelf
      {...shelf}
      title={<Trans>Hidden</Trans>}
      chats={hidden}
      action={<Trans>Unhide</Trans>}
      actionLabel={(chat) => t`Unhide ${chat.name}`}
      onAction={({ kind, chat }) => hide({ kind, ...chat }, false)}
    />
  );
}
