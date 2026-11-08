import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { AttentionItem } from "@rakazo/contracts";
import {
  BotAvatar,
  Button,
  buttonVariants,
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  GroupAvatar,
  SectionHeading,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  CircleAlert,
  Inbox,
  MessageSquare,
  Monitor,
  ShieldAlert,
  TimerOff,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { desktopBridge } from "../lib/desktop";
import { useSpaceQueries } from "../lib/query";
import { formatRelativeTime } from "../lib/relative-time";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

type Section = { key: "waiting" | "failed" | "routines"; title: string; items: AttentionItem[] };

function kindIcon(item: AttentionItem) {
  switch (item.kind) {
    case "question":
      return MessageSquare;
    case "approval":
      return ShieldAlert;
    case "secret":
      return ShieldAlert;
    case "takeover":
      return Monitor;
    case "failed":
      return CircleAlert;
    case "routine_delayed":
      return TimerOff;
  }
}

function itemTitle(item: AttentionItem): string {
  const name = item.groupName ?? item.botName;
  switch (item.kind) {
    case "question":
      return t`${name} needs an answer`;
    case "approval":
      return t`${name} needs approval`;
    case "secret":
      return t`${name} needs a sign-in`;
    case "takeover":
      return t`${name} needs the screen`;
    case "failed":
      return t`${name} failed`;
    case "routine_delayed":
      return t`${name} is behind schedule`;
  }
}

function emptyDetail(item: AttentionItem): string {
  switch (item.kind) {
    case "takeover":
      return t`Open its computer to continue.`;
    case "failed":
      return t`The run stopped before it finished.`;
    case "routine_delayed":
      return t`Its next scheduled run is overdue.`;
    default:
      return "";
  }
}

function itemHref(item: AttentionItem): string {
  if (item.groupId) {
    const params = new URLSearchParams();
    if (item.messageId) params.set("m", item.messageId);
    return `/app/g/${item.groupId}${params.size ? `?${params}` : ""}`;
  }
  const params = new URLSearchParams();
  if (item.messageId) params.set("m", item.messageId);
  if (item.routineId) params.set("routine", item.routineId);
  return `/app/${item.botId}${params.size ? `?${params}` : ""}`;
}

export function NeedsYouPage() {
  const { t: translate } = useLingui();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queries = useSpaceQueries();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const query = useQuery({
    ...queries.attention.list.queryOptions(),
    refetchInterval: 15_000,
  });
  const bootstrap = useQuery(queries.bootstrap.queryOptions({ input: {} })).data;
  const bots = bootstrap?.bots ?? [];
  const groups = bootstrap?.groups ?? [];
  const items = query.data?.items ?? [];
  const sections = (
    [
      {
        key: "waiting",
        title: t`Waiting on you`,
        items: items.filter((item) =>
          ["question", "approval", "secret", "takeover"].includes(item.kind),
        ),
      },
      { key: "failed", title: t`Failed`, items: items.filter((item) => item.kind === "failed") },
      {
        key: "routines",
        title: t`Routines behind`,
        items: items.filter((item) => item.kind === "routine_delayed"),
      },
    ] satisfies Section[]
  ).filter((section) => section.items.length > 0);

  const answer = async (item: AttentionItem, actionId: string, answerValue: string) => {
    if (!item.runId || !item.messageId) return;
    const key = `${item.id}:${actionId}`;
    setBusy(key);
    setActionError(null);
    try {
      await rpc.threads.answer({
        ...(item.groupId ? { groupId: item.groupId } : { botId: item.botId }),
        runId: item.runId,
        messageId: item.messageId,
        answer: answerValue,
      });
      await queryClient.invalidateQueries({ queryKey: queries.attention.list.queryKey() });
    } catch (error) {
      setActionError(errorText(error, translate`Could not answer this card.`));
    } finally {
      setBusy(null);
    }
  };

  const botsById = new Map(bots.map((bot) => [bot.id, bot]));
  const groupsById = new Map(groups.map((group) => [group.id, group]));

  return (
    <div className="flex h-full min-w-0 flex-col bg-background text-foreground/90">
      <header className="app-drag flex items-center gap-2 border-b border-border px-4 py-3">
        {desktopBridge() ? <WindowChrome /> : null}
        <Link
          to="/app"
          aria-label={t`Back`}
          className={buttonVariants({
            variant: "ghost",
            size: "icon",
            className: "app-no-drag text-muted-foreground",
          })}
        >
          <ChevronLeft />
        </Link>
        <h1 className="font-medium text-foreground">
          <Trans>Needs you</Trans>
        </h1>
        {items.length > 0 ? (
          <span className="text-body-sm text-muted-foreground">{items.length}</span>
        ) : null}
        {query.isFetching && !query.isPending ? (
          <Spinner aria-label={t`Refreshing`} className="ms-auto size-4 text-muted-foreground" />
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
          {actionError ? (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-body-sm text-destructive"
            >
              {actionError}
            </div>
          ) : null}

          {query.isPending ? (
            <div className="grid place-items-center py-24 text-muted-foreground">
              <Spinner aria-label={t`Loading…`} />
            </div>
          ) : query.error ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-body-sm text-destructive">
              <p>{errorText(query.error, t`Could not load what needs you.`)}</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-3"
                onClick={() => void query.refetch()}
              >
                <Trans>Try again</Trans>
              </Button>
            </div>
          ) : items.length === 0 ? (
            <Empty className="py-24">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle>
                  <Trans>Nothing needs you</Trans>
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="space-y-8">
              {sections.map((section) => (
                <section key={section.key}>
                  <SectionHeading variant="label" className="mb-3">
                    {section.title}
                  </SectionHeading>
                  <div className="space-y-2">
                    {section.items.map((item) => {
                      const Icon = kindIcon(item);
                      const bot = botsById.get(item.botId);
                      const group = item.groupId ? groupsById.get(item.groupId) : undefined;
                      return (
                        <article
                          key={item.id}
                          data-testid={`attention-item-${item.kind}`}
                          className="flex gap-3 rounded-xl border border-border bg-card px-4 py-3"
                        >
                          {group ? (
                            <GroupAvatar members={group.members} size={32} />
                          ) : bot ? (
                            <BotAvatar
                              identity={bot.id}
                              color={bot.color}
                              avatarSet={bot.avatarSet}
                              size={32}
                            />
                          ) : (
                            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                              <Icon className="size-4" aria-hidden="true" />
                            </span>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                              <h2 className="text-body font-medium text-foreground">
                                {itemTitle(item)}
                              </h2>
                              <span className="ms-auto text-label text-muted-foreground/80">
                                {formatRelativeTime(item.createdAt)}
                              </span>
                            </div>
                            <p className="mt-1 line-clamp-3 text-body-sm text-muted-foreground">
                              {item.detail || emptyDetail(item)}
                            </p>
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              {item.actions.map((action) => (
                                <Button
                                  key={action.id}
                                  variant={
                                    action.tone === "danger"
                                      ? "destructive"
                                      : action.tone === "primary"
                                        ? "default"
                                        : "outline"
                                  }
                                  size="sm"
                                  disabled={busy !== null}
                                  onClick={() => void answer(item, action.id, action.answer)}
                                >
                                  {busy === `${item.id}:${action.id}` ? (
                                    <Spinner aria-label={t`Saving…`} className="size-3.5" />
                                  ) : (
                                    action.label
                                  )}
                                </Button>
                              ))}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-muted-foreground"
                                onClick={() => navigate(itemHref(item))}
                              >
                                <Trans>Open chat</Trans>
                              </Button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
