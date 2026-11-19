import { Trans, useLingui } from "@lingui/react/macro";
import type { ScratchpadItem } from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import { Button, Checkbox, Input, SectionHeading } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Plus, X } from "lucide-react";
import { useId, useState } from "react";
import { useSave, useSpaceQueries } from "../../lib/query/query";

const NO_ITEMS: ScratchpadItem[] = [];

type Change =
  | { title: string }
  | { item: ScratchpadItem; status: ScratchpadItem["status"] }
  | { remove: true; item: ScratchpadItem };

export function ScratchpadSection({ botId }: { botId: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const list = queries.scratchpad.list.queryOptions({ input: { botId } });
  // The bot edits its open work as it runs, so every open refreshes behind the cached list.
  const items = useQuery({ ...list, refetchOnMount: "always" }).data ?? NO_ITEMS;
  const listId = useId();
  // Folded like Settings, so a long list never pushes the rest of the panel away.
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  function setItems(update: (current: ScratchpadItem[]) => ScratchpadItem[]) {
    return writeSaved(queryClient, list.queryKey, (current) => update(current ?? []));
  }

  const change = useSave({
    stale: [list.queryKey],
    save: async (input: Change, rpc) => {
      if ("title" in input) {
        const created = await rpc.scratchpad.create({ botId, title: input.title });
        setDraft("");
        setAdding(false);
        await setItems((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      } else if ("status" in input) {
        const updated = await rpc.scratchpad.update({
          itemId: input.item.id,
          status: input.status,
        });
        await setItems((current) => {
          const next = current.map((entry) => (entry.id === updated.id ? updated : entry));
          return input.status === "done" ? next.filter((entry) => entry.status !== "done") : next;
        });
      } else {
        await rpc.scratchpad.remove({ itemId: input.item.id });
        await setItems((current) => current.filter((entry) => entry.id !== input.item.id));
      }
    },
  });
  const busy = change.pending;
  const input = change.input;
  const error = change.error
    ? input && "title" in input
      ? t`Could not add`
      : input && "status" in input
        ? t`Could not update`
        : t`Could not remove`
    : null;

  function run(next: Change) {
    if (busy) return;
    change.run(next);
  }

  function addItem() {
    const title = draft.trim();
    if (!title) return;
    run({ title });
  }

  if (!items.length && !error && !adding) return null;

  return (
    <div className="mt-6" data-testid="bot-scratchpad">
      <SectionHeading variant="label" className="flex min-h-6 items-center gap-1 pe-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
          className="-my-2 flex min-h-10 min-w-0 flex-1 items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Trans>Open work</Trans>
          {items.length ? <span className="tabular-nums">{items.length}</span> : null}
          <ChevronDown
            aria-hidden="true"
            className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Add open work`}
          title={t`Add open work`}
          onClick={() => {
            setAdding(!(open && adding));
            setOpen(true);
          }}
        >
          <Plus className="size-4" />
        </Button>
      </SectionHeading>
      {/* Stays mounted so a draft survives folding the list away. */}
      <div id={listId} hidden={!open} className="mt-2 rounded-xl bg-muted/50 p-4">
        {(showAll ? items : items.slice(0, 5)).map((item) => (
          <div
            key={item.id}
            className="group -mx-2.5 flex items-start gap-2 rounded-lg px-2.5 py-2 hover:bg-accent/50"
          >
            <Checkbox
              aria-label={item.status === "done" ? t`Reopen` : t`Complete`}
              checked={item.status === "done"}
              disabled={busy}
              onCheckedChange={(checked) => run({ item, status: checked ? "done" : "open" })}
              className="mt-[3px]"
            />
            <div className="min-w-0 flex-1">
              {/* One line each until opened, so the list stays scannable whatever a note holds. */}
              <button
                type="button"
                aria-expanded={expandedId === item.id}
                onClick={() => setExpandedId((id) => (id === item.id ? null : item.id))}
                className={`block w-full rounded-sm text-start text-body-lg outline-none focus-visible:ring-2 focus-visible:ring-ring ${expandedId === item.id ? "break-words" : "truncate"} ${item.status === "done" ? "text-muted-foreground/80 line-through" : "text-foreground"}`}
                dir="auto"
              >
                {item.title}
              </button>
              {item.notes && expandedId === item.id ? (
                <div
                  className="mt-0.5 whitespace-pre-wrap break-words text-body-sm text-muted-foreground/80"
                  dir="auto"
                >
                  {item.notes}
                </div>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t`Remove`}
              disabled={busy}
              onClick={() => run({ remove: true, item })}
              className="-mt-0.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100"
            >
              <X />
            </Button>
          </div>
        ))}
        {items.length > 5 && !showAll ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 w-full text-muted-foreground"
            onClick={() => setShowAll(true)}
          >
            <Trans>Show more</Trans>
          </Button>
        ) : null}
        {adding ? (
          <form
            className={`flex items-center gap-2 ${items.length ? "mt-2" : ""}`}
            onSubmit={(event) => {
              event.preventDefault();
              addItem();
            }}
          >
            <Input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t`Add item`}
              aria-label={t`New open-work item`}
              maxLength={200}
              className="min-w-0 flex-1"
            />
            <Button variant="secondary" disabled={busy || !draft.trim()} onClick={addItem}>
              <Trans>Add</Trans>
            </Button>
          </form>
        ) : null}
      </div>
      {error ? <div className="mt-2 text-body-sm text-destructive">{error}</div> : null}
    </div>
  );
}
