import { Trans } from "@lingui/react/macro";
import type { SearchHit } from "@rakazo/contracts";
import { searchHitListKey } from "@rakazo/core";

export function SpaceSearchResults({
  hits,
  loading,
  onSelect,
}: {
  hits: SearchHit[];
  loading: boolean;
  onSelect: (hit: SearchHit) => void;
}) {
  if (loading) {
    return (
      <div className="px-3 py-4 text-[14px] text-muted-foreground">
        <Trans>Searching…</Trans>
      </div>
    );
  }
  if (!hits.length) {
    return (
      <div className="px-3 py-4 text-[14px] text-muted-foreground">
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
            <span className="truncate text-[15px] font-medium text-foreground" dir="auto">
              {hit.title}
            </span>
            <span className="shrink-0 text-[12px] uppercase tracking-wide text-muted-foreground/80">
              {hit.kind}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 gap-2 text-[13px] text-muted-foreground" dir="auto">
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
