import { Trans } from "@lingui/react/macro";
import type { SearchHit } from "@rakazo/contracts";

export function WorkspaceSearchResults({
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
      <div className="px-3 py-4 text-[14px] text-[#85858A]">
        <Trans>Searching…</Trans>
      </div>
    );
  }
  if (!hits.length) {
    return (
      <div className="px-3 py-4 text-[14px] text-[#85858A]">
        <Trans>No results</Trans>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {hits.map((hit) => (
        <button
          key={`${hit.kind}-${hit.botId ?? hit.groupId}-${hit.messageId ?? hit.artifactId ?? hit.routineId ?? hit.url}`}
          type="button"
          onClick={() => onSelect(hit)}
          className="rounded-xl px-2.5 py-[11px] text-start hover:bg-[#131315]"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[15px] font-medium text-[#ECECEE]" dir="auto">
              {hit.title}
            </span>
            <span className="shrink-0 text-[12px] uppercase tracking-wide text-[#6C6C70]">
              {hit.kind}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[13px] text-[#85858A]" dir="auto">
            {hit.groupName ?? hit.botName} · {hit.snippet}
          </div>
        </button>
      ))}
    </div>
  );
}
