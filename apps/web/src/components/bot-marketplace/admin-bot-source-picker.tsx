import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { MarketplaceBotSource } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";

/** The first letter of a name on a quiet tile, so a listing and its source bot read as one thing. */
export function NameTile({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted font-medium text-foreground"
    >
      {Array.from(name.trim())[0] ?? ""}
    </span>
  );
}

/** What a listing copies from a bot, each count as its own muted piece. */
export function SourceCounts({
  space,
  skills,
  routines,
}: {
  space?: string;
  skills: number;
  routines: number;
}) {
  return (
    <span className="flex flex-wrap gap-x-3 text-body-sm text-muted-foreground">
      {space ? <span>{space}</span> : null}
      <span>
        <Plural value={skills} one="# skill" other="# skills" />
      </span>
      <span>
        <Plural value={routines} one="# routine" other="# routines" />
      </span>
    </span>
  );
}

/** Pick the bot a listing is built from: its instructions, skills and routines are copied. */
export function AdminBotSourcePicker({
  busy,
  error,
  onPick,
  onClose,
}: {
  busy: boolean;
  /** Why copying from the chosen bot failed. */
  error: Error | null;
  onPick: (source: MarketplaceBotSource) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const sources = useQuery({
    ...useSpaceQueries().botMarketplace.admin.sources.queryOptions({ input: {} }),
    staleTime: 0,
  });
  const list = sources.data ?? [];
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent showCloseButton={false} size="md" className="bg-card">
        <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
          <DialogTitle className="text-heading2 text-foreground">
            <Trans>Choose a bot</Trans>
          </DialogTitle>
          <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label={t`Close`} />}>
            <X />
          </DialogClose>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-4 pb-8">
          {error ? (
            <p role="alert" className="mb-3 text-body-sm text-destructive">
              {errorText(error, t`Could not copy from that bot`)}
            </p>
          ) : null}
          {sources.isPending ? (
            <div className="grid place-items-center py-10">
              <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
            </div>
          ) : sources.isError ? (
            <div role="alert" className="flex items-center gap-3 text-body text-destructive">
              {errorText(sources.error, t`Couldn't load your bots`)}
              <Button variant="outline" size="sm" onClick={() => void sources.refetch()}>
                <Trans>Retry</Trans>
              </Button>
            </div>
          ) : list.length === 0 ? (
            <p className="py-10 text-center text-body text-muted-foreground">
              <Trans>You have no bots in this Space yet.</Trans>
            </p>
          ) : (
            <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
              {list.map((source) => (
                <li key={source.botId}>
                  <button
                    type="button"
                    disabled={busy}
                    className="flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-muted/50 focus-visible:outline-none disabled:opacity-50"
                    onClick={() => onPick(source)}
                  >
                    <NameTile name={source.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body-lg font-medium text-foreground">
                        {source.name}
                      </span>
                      <SourceCounts
                        space={source.spaceName}
                        skills={source.skills}
                        routines={source.routines}
                      />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
