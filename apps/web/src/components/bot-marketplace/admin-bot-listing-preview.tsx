import { Plural, Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { MarketplaceBot } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { NameTile } from "./admin-bot-source-picker";

function Block({
  title,
  note,
  children,
}: {
  title: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="flex items-baseline gap-2 text-body-lg font-semibold text-foreground">
        {title}
        {note ? (
          <span className="text-body-sm font-normal text-muted-foreground">{note}</span>
        ) : null}
      </h3>
      {children}
    </section>
  );
}

/** The listing in one compact card: what a user reads before deciding to add the bot. */
export function AdminBotListingPreview({
  listing,
  categoryLabel,
}: {
  listing: MarketplaceBot;
  categoryLabel: string;
}) {
  const outcomes = listing.outcomes.filter(Boolean);
  return (
    <article
      data-testid="bot-listing-preview"
      className="space-y-6 rounded-xl border border-border/70 bg-card p-6"
    >
      <header className="flex items-center gap-4">
        <NameTile name={listing.name} />
        <div className="min-w-0">
          <p className="text-body-sm text-muted-foreground">{categoryLabel}</p>
          <h2 className="truncate text-heading2 font-semibold text-foreground">{listing.name}</h2>
        </div>
      </header>
      <p className="text-body-lg text-foreground">{listing.tagline}</p>
      {outcomes.length ? (
        <Block title={<Trans>What it does for users</Trans>}>
          <div className="space-y-1 text-body-lg text-foreground">
            {outcomes.map((outcome) => (
              <p key={outcome}>{outcome}</p>
            ))}
          </div>
        </Block>
      ) : null}
      <Block title={<Trans>Example output</Trans>} note={<Trans>Demo data</Trans>}>
        <div className="text-body-lg text-foreground">
          <ChatMarkdown>{listing.sample}</ChatMarkdown>
        </div>
      </Block>
      {listing.intro ? (
        <Block title={<Trans>First message after install</Trans>}>
          <p className="text-body-lg text-foreground">{listing.intro}</p>
        </Block>
      ) : null}
      <Block title={<Trans>Template setup</Trans>}>
        <p className="flex flex-wrap gap-x-3 text-body text-muted-foreground">
          <span>
            <Plural value={listing.skills.length} one="# skill" other="# skills" />
          </span>
          <span>
            <Plural
              value={listing.routines.length}
              one="# routine, paused after install"
              other="# routines, paused after install"
            />
          </span>
          {listing.apps.length ? <span>{listing.apps.join(", ")}</span> : null}
        </p>
      </Block>
    </article>
  );
}
