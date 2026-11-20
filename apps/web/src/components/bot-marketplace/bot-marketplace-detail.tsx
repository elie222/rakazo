import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { MarketplaceBot } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import { Button, Disclosure, SectionHeading } from "@rakazo/ui-web";
import { Clock, LayoutTemplate, Plug } from "lucide-react";
import { cronLabels } from "../../lib/routines/cron";

/**
 * The listing as users see it (sketch screen 2): what it does, the apps and routines it needs,
 * an example marked as demo data, and the configuration folded away. Presentational, so the
 * ops console previews the same component the market will render.
 */
export function BotMarketplaceDetail({
  listing,
  botId,
  installedVersion = null,
  onAdd,
  onOpen,
  busy = false,
  appNames = {},
}: {
  listing: MarketplaceBot;
  botId?: string | null;
  /** The listing version the user's bot was made from, when known. */
  installedVersion?: number | null;
  onAdd?: () => void;
  onOpen?: () => void;
  busy?: boolean;
  /** Connection catalog names for the listing's app slugs; slugs show until resolved. */
  appNames?: Record<string, string>;
}) {
  const { t, i18n } = useLingui();
  const schedule = (crons: string[]) =>
    crons.map((cron) => formatCron(cron, cronLabels(i18n.locale))).join(", ");
  const apps = listing.apps.map((slug) => appNames[slug] ?? slug);
  const outdated =
    Boolean(botId) && installedVersion !== null && installedVersion < listing.version;

  return (
    <div data-testid="bot-marketplace-detail" className="space-y-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <span
          aria-hidden
          className="grid h-16 w-16 place-items-center rounded-2xl border border-border/60 bg-muted text-foreground"
        >
          <LayoutTemplate size={28} />
        </span>
        <div className="min-w-0">
          <h2 className="text-heading2 font-semibold text-foreground">{listing.name}</h2>
          <p className="flex flex-wrap justify-center gap-x-2 text-body-sm text-muted-foreground">
            {listing.author.url ? (
              <a
                href={listing.author.url}
                target="_blank"
                rel="noreferrer"
                className="text-foreground underline"
              >
                {listing.author.name}
              </a>
            ) : (
              <span>{listing.author.name}</span>
            )}
            <span>{listing.license}</span>
          </p>
        </div>
        <p className="max-w-[54ch] text-body text-muted-foreground">{listing.description}</p>
        <ul className="max-w-[54ch] list-disc space-y-1 ps-5 text-start text-body">
          {listing.outcomes.map((outcome) => (
            <li key={outcome}>{outcome}</li>
          ))}
        </ul>
      </div>

      {outdated ? (
        <div className="rounded-xl border border-border/70 px-4 py-3 text-body-sm">
          <p className="font-medium text-foreground">
            <Trans>A newer version of this bot is available.</Trans>
          </p>
          {listing.versionNote ? (
            <p className="mt-1 text-muted-foreground">{listing.versionNote}</p>
          ) : null}
        </div>
      ) : null}

      <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
        <li className="flex items-center gap-3 px-4 py-3">
          <Plug size={16} className="shrink-0 text-muted-foreground" />
          <span className="w-24 shrink-0 text-body-sm text-muted-foreground">
            <Trans>Apps</Trans>
          </span>
          <span className="min-w-0 flex-1 text-body">
            {apps.length ? apps.join(", ") : <Trans>No connections needed</Trans>}
          </span>
        </li>
        <li className="flex items-center gap-3 px-4 py-3">
          <Clock size={16} className="shrink-0 text-muted-foreground" />
          <span className="w-24 shrink-0 text-body-sm text-muted-foreground">
            <Trans>Routines</Trans>
          </span>
          <span className="min-w-0 flex-1 text-body">
            {listing.routines.length
              ? listing.routines
                  .map(
                    (routine) =>
                      t`${routine.name}: ${schedule(routine.crons)}, paused until you turn it on`,
                  )
                  .join("; ")
              : t`None`}
          </span>
        </li>
      </ul>

      <Disclosure
        summary={
          <span className="text-body-sm text-muted-foreground">{t`View configuration`}</span>
        }
        contentClassName="space-y-3 pt-2"
      >
        <div className="rounded-xl border border-border/60 bg-background px-4 py-3 text-body-sm">
          <ChatMarkdown>{listing.instructions}</ChatMarkdown>
        </div>
        {listing.skills.map((skill) => (
          <div
            key={skill.name}
            className="rounded-xl border border-border/60 bg-background px-4 py-3 text-body-sm"
          >
            <p className="font-medium text-foreground">{skill.name}</p>
            <p className="text-muted-foreground">{skill.description}</p>
          </div>
        ))}
      </Disclosure>

      <section className="space-y-2">
        <SectionHeading className="px-1">
          <Trans>Example output</Trans>
        </SectionHeading>
        <div className="rounded-xl border border-border/60 bg-background px-4 py-3 text-body">
          <ChatMarkdown>{listing.sample}</ChatMarkdown>
        </div>
        <p className="px-1 text-caption text-muted-foreground">
          <Trans>Demo data, not your real content.</Trans>
        </p>
      </section>

      {onAdd || onOpen ? (
        <div className="sticky bottom-0 -mx-1 flex justify-end border-t border-border/60 bg-card px-1 py-3">
          {botId ? (
            <Button variant="secondary" disabled={busy} onClick={onOpen}>
              <Trans>Open my bot</Trans>
            </Button>
          ) : (
            <Button size="lg" className="px-5" disabled={busy} onClick={onAdd}>
              {busy ? <Trans>Adding…</Trans> : <Trans>Add bot</Trans>}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
