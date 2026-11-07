import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group } from "@rakazo/contracts";
import { BotAvatar, Button, GroupAvatar } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { SidebarShelf } from "./sidebar-shelf";
import type { SnoozeChat } from "./use-chat-snooze";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The open space's snoozed chats, collapsed under the roster, each with its wake time. */
export function SnoozedChats({
  snoozedBots,
  snoozedGroups,
  showSpaceSearch,
  now,
  snooze,
  openChat,
}: {
  snoozedBots: Bot[];
  snoozedGroups: Group[];
  showSpaceSearch: boolean;
  now: number;
  snooze: SnoozeChat;
  openChat: (path: string) => void;
}) {
  const { t, i18n } = useLingui();
  const count = snoozedBots.length + snoozedGroups.length;
  if (count === 0 || showSpaceSearch) return null;
  const wakeLabel = (until: string | null | undefined) => {
    const wake = new Date(until ?? "");
    const today = new Date(now).toDateString() === wake.toDateString();
    return i18n.date(wake, {
      ...(today
        ? {}
        : wake.getTime() - now < 6 * DAY_MS
          ? { weekday: "short" }
          : { month: "short", day: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
    });
  };
  const row = (kind: "bot" | "group", chat: Bot | Group, avatar: ReactNode) => (
    <div
      key={`${kind}:${chat.id}`}
      className="group/shelf flex items-center gap-2 rounded-lg px-2.5 py-1 hover:bg-sidebar-accent"
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-start"
        onClick={() => openChat(kind === "bot" ? `/app/${chat.id}` : `/app/g/${chat.id}`)}
      >
        {avatar}
        <span className="min-w-0 flex-1 truncate text-body text-foreground/75" dir="auto">
          {chat.name}
        </span>
        <span className="shrink-0 text-label text-faint-foreground tabular-nums group-focus-within/shelf:hidden group-hover/shelf:hidden">
          {wakeLabel(chat.snoozedUntil)}
        </span>
      </button>
      <Button
        variant="ghost"
        size="xs"
        className="sr-only focus-visible:not-sr-only group-hover/shelf:not-sr-only"
        aria-label={t`Unsnooze ${chat.name}`}
        onClick={() => snooze(kind, chat.id, null)}
      >
        <Trans>Unsnooze</Trans>
      </Button>
    </div>
  );
  return (
    <SidebarShelf title={<Trans>Snoozed</Trans>} count={count}>
      {snoozedBots.map((bot) =>
        row(
          "bot",
          bot,
          <BotAvatar
            avatarSet={bot.avatarSet}
            color={bot.color}
            identity={bot.id}
            size={28}
            status={bot.status}
          />,
        ),
      )}
      {snoozedGroups.map((group) =>
        row("group", group, <GroupAvatar members={group.members} size={28} />),
      )}
    </SidebarShelf>
  );
}
