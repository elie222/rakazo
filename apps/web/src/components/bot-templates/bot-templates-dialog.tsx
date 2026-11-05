import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Bot, BotTemplateListing, ConnectionCatalogItem } from "@rakazo/contracts";
import { isBotTemplateChanged } from "@rakazo/contracts";
import { botTemplateApps, formatCron } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  SectionHeading,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  Bot as BotIcon,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  GitPullRequest,
  Inbox,
  LayoutTemplate,
  ScrollText,
  Sun,
  Telescope,
  X,
} from "lucide-react";
import { useState } from "react";
import { cronLabels } from "../../lib/cron";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import type { ErrorDetails } from "../../lib/user-error";
import { errorDetails } from "../../lib/user-error";
import { ErrorNotice } from "../ErrorNotice";
import { PluginLogo, ROW_HOVER } from "../integrations/plugin-marketplace";
import { useBotTemplateCopy } from "./bot-template-copy";

const ICONS: Record<string, LucideIcon> = {
  "morning-briefing": Sun,
  "inbox-triage": Inbox,
  "pr-reviewer": GitPullRequest,
  "topic-watch": Telescope,
};

function TemplateIcon({ id, large = false }: { id: string; large?: boolean }) {
  const Icon = ICONS[id] ?? LayoutTemplate;
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center border border-border/60 bg-muted text-foreground ${
        large ? "h-14 w-14 rounded-2xl" : "h-10 w-10 rounded-xl"
      }`}
    >
      <Icon size={large ? 24 : 18} />
    </span>
  );
}

function Sample({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background px-4 py-3 text-[14px]">
      <ChatMarkdown>{text}</ChatMarkdown>
    </div>
  );
}

/** Ready-made bots. Creating one opens it; its routines stay paused until the user turns them on. */
export function BotTemplatesDialog({
  onClose,
  onOpenBot,
}: {
  onClose: () => void;
  onOpenBot: (bot: Bot) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const copy = useBotTemplateCopy();
  const templates = useQuery(queries.bots.templates.queryOptions());
  const [openId, setOpenId] = useState<string | null>(null);
  const open = templates.data?.find((template) => template.id === openId);
  const [featured, ...others] = templates.data ?? [];

  function content() {
    if (templates.error)
      return (
        <ErrorNotice error={errorDetails(templates.error, t`Could not load templates`)}>
          <Button variant="outline" size="sm" onClick={() => void templates.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </ErrorNotice>
      );
    if (!featured)
      return (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      );
    if (open)
      return (
        <TemplateDetail
          template={open}
          onBack={() => setOpenId(null)}
          onOpenBot={onOpenBot}
          onChanged={() => void templates.refetch()}
        />
      );
    const featuredCopy = copy(featured);
    return (
      <div className="space-y-4">
        <button
          type="button"
          data-testid="bot-template-featured"
          onClick={() => setOpenId(featured.id)}
          className={`block w-full space-y-4 rounded-2xl border border-border/70 p-5 text-start focus-visible:outline-none ${ROW_HOVER}`}
        >
          <span className="flex items-center gap-3">
            <TemplateIcon id={featured.id} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium text-foreground">
                {featuredCopy.name}
              </span>
              <span className="block truncate text-[13px] text-muted-foreground">
                {featuredCopy.summary}
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </span>
          <Sample text={featuredCopy.sample} />
        </button>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {others.map((template) => {
            const { name, summary } = copy(template);
            return (
              <button
                key={template.id}
                type="button"
                data-testid="bot-template-row"
                onClick={() => setOpenId(template.id)}
                className={`flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 text-start focus-visible:outline-none ${ROW_HOVER}`}
              >
                <TemplateIcon id={template.id} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium text-foreground">
                    {name}
                  </span>
                  <span className="block truncate text-[13px] text-muted-foreground">
                    {summary}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="bot-templates-dialog"
        className="flex h-[680px] max-h-[calc(100%-2rem)] w-[760px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 sm:max-w-[760px]"
      >
        <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
          <DialogTitle className="text-heading2 text-foreground">
            <Trans>Bot templates</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close bot templates`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-5 pb-8">{content()}</div>
      </DialogContent>
    </Dialog>
  );
}

function TemplateDetail({
  template,
  onBack,
  onOpenBot,
  onChanged,
}: {
  template: BotTemplateListing;
  onBack: () => void;
  onOpenBot: (bot: Bot) => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const { name, summary, sample } = useBotTemplateCopy()(template);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorDetails | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const catalog = useQuery({
    ...queries.connections.catalog.queryOptions({ input: {} }),
    enabled: template.apps.length > 0,
  });
  const apps = botTemplateApps(template, catalog.data ?? []);
  const schedule = (crons: string[]) =>
    crons.map((cron) => formatCron(cron, cronLabels(i18n.locale))).join(", ");

  async function create() {
    setPending(true);
    setError(null);
    try {
      const { bot } = await rpc.bots.createFromTemplate({
        templateId: template.id,
        version: template.version,
      });
      onOpenBot(bot);
    } catch (err) {
      const changed = isBotTemplateChanged(err);
      setError(
        errorDetails(
          changed ? t`This template was just updated. Check it again.` : err,
          t`Could not create the bot`,
        ),
      );
      if (changed) onChanged();
      setPending(false);
    }
  }

  async function openExisting(botId: string) {
    setPending(true);
    try {
      onOpenBot(await rpc.bots.get({ botId }));
    } catch (err) {
      setError(errorDetails(err, t`Could not open the bot`));
      setPending(false);
    }
  }

  const rows: { key: string; icon: LucideIcon; title: string; detail: string; body?: string }[] = [
    {
      key: "bot",
      icon: BotIcon,
      title: name,
      detail: t`Instructions`,
      body: template.instructions,
    },
    ...template.skills.map((skill) => ({
      key: `skill:${skill.name}`,
      icon: ScrollText,
      title: skill.name,
      detail: t`Skill`,
      body: skill.body,
    })),
    ...template.routines.map((routine, index) => ({
      key: `routine:${index}`,
      icon: Clock,
      title: routine.name,
      detail: t`${schedule(routine.crons)}, paused until you turn it on`,
      body: routine.prompt,
    })),
  ];

  return (
    <div data-testid="bot-template-detail" className="space-y-7">
      <div className="flex items-start gap-4">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="mt-3.5 -ms-2 text-muted-foreground"
          aria-label={t`Back`}
          disabled={pending}
          onClick={onBack}
        >
          <ChevronLeft />
        </Button>
        <TemplateIcon id={template.id} large />
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="truncate text-[20px] font-semibold text-foreground">{name}</h2>
          <p className="truncate text-[13.5px] text-muted-foreground">{summary}</p>
        </div>
        <div className="shrink-0 pt-2">
          {template.botId ? (
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => void openExisting(template.botId!)}
            >
              <Trans>Open</Trans>
            </Button>
          ) : (
            <Button size="lg" className="px-5" disabled={pending} onClick={() => void create()}>
              {pending ? <Trans>Creating…</Trans> : <Trans>Create bot</Trans>}
            </Button>
          )}
        </div>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <Sample text={sample} />

      <section className="space-y-2">
        <SectionHeading className="px-1">
          <Trans>Adds</Trans>
        </SectionHeading>
        <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
          {rows.map((row) => {
            const Icon = row.icon;
            const isOpen = expanded === row.key;
            return (
              <li key={row.key}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : row.key)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-start focus-visible:outline-none"
                >
                  <Icon size={16} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-medium">{row.title}</span>
                    <span className="block truncate text-[12.5px] text-muted-foreground">
                      {row.detail}
                    </span>
                  </span>
                  <ChevronDown
                    size={16}
                    className={`shrink-0 text-muted-foreground transition-transform ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
                {isOpen && row.body ? (
                  <pre className="mx-4 mb-3 max-h-64 overflow-auto rounded-lg bg-muted/60 p-3 font-sans text-[13px] whitespace-pre-wrap text-muted-foreground">
                    {row.body}
                  </pre>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      {apps.length ? <AppsSection apps={apps} /> : null}
    </div>
  );
}

function AppsSection({ apps }: { apps: ConnectionCatalogItem[] }) {
  const { t } = useLingui();
  return (
    <section className="space-y-2">
      <SectionHeading className="px-1">
        <Trans>Works with</Trans>
      </SectionHeading>
      <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
        {apps.map((app) => (
          <li key={app.slug} className="flex items-center gap-3 px-4 py-3">
            <PluginLogo name={app.name} logo={app.logo} />
            <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium">{app.name}</span>
            {app.connected ? (
              <Check role="img" aria-label={t`Connected`} className="size-4 text-success" />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
