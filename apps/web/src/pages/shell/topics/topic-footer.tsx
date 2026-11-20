import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { BotAvatarSet, TopicSummary } from "@rakazo/contracts";
import { BotAvatar } from "@rakazo/ui-web";
import { UserRound } from "lucide-react";
import { formatRelativeTime } from "../../../lib/locale/relative-time";

/** Under a chat message that has a thread: who is in it, how many replies, and when it last moved. */
export function TopicFooter({
  topic,
  bot,
  onOpen,
}: {
  topic: TopicSummary;
  bot: { id: string; color: string; avatarSet?: BotAvatarSet };
  onOpen: (topicId: string) => void;
}) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      data-testid="topic-footer"
      onClick={() => onOpen(topic.id)}
      className="mt-1 flex items-center gap-1.5 rounded-md py-0.5 pe-1.5 text-body-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span aria-hidden="true" className="flex items-center -space-x-1">
        <BotAvatar avatarSet={bot.avatarSet} color={bot.color} identity={bot.id} size={16} />
        <span className="grid size-4 place-items-center rounded-full bg-muted text-muted-foreground ring-1 ring-background">
          <UserRound className="size-2.5" />
        </span>
      </span>
      <span className="font-semibold text-foreground">
        {t`${plural(topic.replyCount, { one: "# reply", other: "# replies" })}`}
      </span>
      <span className="text-muted-foreground">{formatRelativeTime(topic.lastActivityAt)}</span>
      {topic.unread ? (
        <span aria-hidden="true" className="size-1.5 rounded-full bg-unread" />
      ) : null}
      {topic.settledBy ? (
        <span className="text-muted-foreground">
          <Trans>Done</Trans>
        </span>
      ) : null}
    </button>
  );
}
