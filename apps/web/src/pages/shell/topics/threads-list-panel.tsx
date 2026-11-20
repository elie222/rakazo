import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { TopicSummary } from "@rakazo/contracts";
import { Button, cn, SectionHeading } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { formatRelativeTime } from "../../../lib/locale/relative-time";
import { splitTopics } from "./topics";

/** The bot chat's threads: open ones first, then the ones that are done. */
export function ThreadsListPanel({
  topics,
  onOpen,
  onClose,
}: {
  topics: readonly TopicSummary[];
  onOpen: (topicId: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const { open, done } = splitTopics(topics);
  return (
    <div className="rk-scroll h-full w-full overflow-y-auto px-5 py-[17px]">
      <div className="mb-3 flex items-center justify-between">
        <SectionHeading as="h2">
          <Trans>Threads</Trans>
        </SectionHeading>
        <Button variant="ghost" size="icon-sm" aria-label={t`Close panel`} onClick={onClose}>
          <X size={16} strokeWidth={1.8} />
        </Button>
      </div>
      <TopicRows topics={open} onOpen={onOpen} />
      {done.length ? (
        <>
          <SectionHeading variant="label" className="mt-5 mb-1">
            <Trans>Done</Trans>
          </SectionHeading>
          <TopicRows topics={done} onOpen={onOpen} />
        </>
      ) : null}
    </div>
  );
}

function TopicRows({
  topics,
  onOpen,
}: {
  topics: readonly TopicSummary[];
  onOpen: (topicId: string) => void;
}) {
  const { t } = useLingui();
  return (
    <ul className="-mx-2 flex flex-col">
      {topics.map((topic) => (
        <li key={topic.id}>
          <button
            type="button"
            data-testid="thread-row"
            onClick={() => onOpen(topic.id)}
            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span
              aria-hidden="true"
              className={cn(
                "mt-[7px] size-1.5 shrink-0 rounded-full",
                topic.unread ? "bg-unread" : "bg-transparent",
              )}
            />
            <span className="min-w-0 flex-1">
              <span
                dir="auto"
                className={cn(
                  "block truncate text-body text-foreground",
                  topic.unread && "font-semibold",
                )}
              >
                {topic.title}
              </span>
              <span className="flex gap-2 text-body-sm text-muted-foreground">
                <span>{t`${plural(topic.replyCount, { one: "# reply", other: "# replies" })}`}</span>
                <span>{formatRelativeTime(topic.lastActivityAt)}</span>
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
