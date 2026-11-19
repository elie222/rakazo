import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import { Button } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useSave, useSpaceQueries } from "../../../lib/query/query";

type OpenWorkEventBlock = Extract<MessageBlock, { kind: "open_work_event" }>;

/** The one-line chat row for an item the bot added to its open work, removable while it is still open. */
export function OpenWorkEventRow({ block, botId }: { block: OpenWorkEventBlock; botId?: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const list = queries.scratchpad.list.queryOptions({ input: { botId: botId ?? "" } });
  const items = useQuery({ ...list, enabled: Boolean(botId) }).data;
  const remove = useSave({
    stale: [list.queryKey],
    save: async (_: null, rpc) => {
      await rpc.scratchpad.remove({ itemId: block.itemId });
      await writeSaved(queryClient, list.queryKey, (current) =>
        (current ?? []).filter((item) => item.id !== block.itemId),
      );
    },
  });
  const title = block.title;
  return (
    <div
      data-testid="open-work-event-row"
      className="group flex items-center justify-center gap-1 py-0.5 text-body text-muted-foreground"
    >
      <span dir="auto" className="min-w-0 break-words text-center">
        {t`Added to open work "${title}"`}
      </span>
      {items?.some((item) => item.id === block.itemId) ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Remove`}
          title={t`Remove`}
          disabled={remove.pending}
          onClick={() => remove.run(null)}
          className="shrink-0 text-muted-foreground"
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}
