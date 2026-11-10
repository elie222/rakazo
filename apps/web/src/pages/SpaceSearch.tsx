import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { SearchHit } from "@rakazo/contracts";
import { searchHitListKey } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";

export function SpaceSearchResults({
  hits,
  loading,
  error,
  onRetry,
  onSelect,
}: {
  hits: SearchHit[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSelect: (hit: SearchHit) => void;
}) {
  if (loading) {
    return (
      <div className="px-3 py-4 text-body text-muted-foreground">
        <Trans>Searching…</Trans>
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-3 py-4">
        <p role="alert" className="text-body text-destructive">
          {error}
        </p>
        <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  }
  if (!hits.length) {
    return (
      <div className="px-3 py-4 text-body text-muted-foreground">
        <Trans>No results</Trans>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {hits.map((hit) => (
        <button
          key={searchHitListKey(hit)}
          type="button"
          onClick={() => onSelect(hit)}
          className="rounded-xl px-2.5 py-[11px] text-start hover:bg-sidebar-accent"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-body-lg font-medium text-foreground" dir="auto">
              {hit.title}
            </span>
            <span className="shrink-0 text-label uppercase tracking-wide text-muted-foreground/80">
              {searchKindLabel(hit)}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 gap-2 text-body-sm text-muted-foreground" dir="auto">
            <span className="max-w-[40%] shrink-0 truncate text-foreground/75">
              {hit.groupName ?? hit.botName}
            </span>
            <span className="truncate">{hit.snippet}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function searchKindLabel(hit: SearchHit): string {
  switch (hit.kind) {
    case "conversation":
      return hit.groupId ? t`Group` : t`Bot`;
    case "message":
      return t`Message`;
    case "file":
      return t`File`;
    case "link":
      return t`Link`;
    case "routine":
      return t`Routine`;
  }
}
