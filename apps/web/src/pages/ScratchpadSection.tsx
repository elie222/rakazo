import { Trans, useLingui } from "@lingui/react/macro";
import type { ScratchpadItem } from "@rakazo/contracts";
import { Button, Checkbox, Input } from "@rakazo/ui-web";
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { rpc } from "../lib/rpc";

export function ScratchpadSection({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [items, setItems] = useState<ScratchpadItem[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listGeneration = useRef(0);

  async function refresh() {
    const generation = ++listGeneration.current;
    const list = await rpc.scratchpad.list({ botId });
    if (generation !== listGeneration.current) return;
    setItems(list);
  }

  useEffect(() => {
    const generation = ++listGeneration.current;
    void rpc.scratchpad
      .list({ botId })
      .then((list) => {
        if (generation !== listGeneration.current) return;
        setItems(list);
      })
      .catch(() => {
        if (generation !== listGeneration.current) return;
        setItems([]);
      });
    return () => {
      listGeneration.current += 1;
    };
  }, [botId]);

  async function addItem() {
    const title = draft.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await rpc.scratchpad.create({ botId, title });
      setDraft("");
      setAdding(false);
      setItems((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      try {
        await refresh();
      } catch {
        setError(t`Saved, but list refresh failed`);
      }
    } catch {
      setError(t`Could not add`);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(item: ScratchpadItem, status: ScratchpadItem["status"]) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await rpc.scratchpad.update({ itemId: item.id, status });
      setItems((current) => {
        const next = current.map((entry) => (entry.id === updated.id ? updated : entry));
        return status === "done" ? next.filter((entry) => entry.status !== "done") : next;
      });
      try {
        await refresh();
      } catch {
        setError(t`Saved, but list refresh failed`);
      }
    } catch {
      setError(t`Could not update`);
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(item: ScratchpadItem) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.scratchpad.remove({ itemId: item.id });
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      try {
        await refresh();
      } catch {
        setError(t`Removed, but list refresh failed`);
      }
    } catch {
      setError(t`Could not remove`);
    } finally {
      setBusy(false);
    }
  }

  if (!items.length && !error) return null;

  return (
    <div className="mt-6" data-testid="bot-scratchpad">
      <h3 className="mb-2 flex items-center justify-between text-xs font-medium text-muted-foreground pe-1">
        <Trans>Open work</Trans>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Add open work`}
          title={t`Add open work`}
          onClick={() => setAdding((value) => !value)}
        >
          <Plus className="size-4" />
        </Button>
      </h3>
      <div className="rounded-xl bg-muted/50 p-4">
        {(showAll ? items : items.slice(0, 5)).map((item) => (
          <div
            key={item.id}
            className="group -mx-2.5 flex items-start gap-2 rounded-lg px-2.5 py-2 hover:bg-accent/50"
          >
            <Checkbox
              aria-label={item.status === "done" ? t`Reopen` : t`Complete`}
              checked={item.status === "done"}
              disabled={busy}
              onCheckedChange={(checked) => void setStatus(item, checked ? "done" : "open")}
              className="mt-[3px]"
            />
            <div className="min-w-0 flex-1">
              <div
                className={`text-start text-[14.5px] ${item.status === "done" ? "text-muted-foreground/80 line-through" : "text-foreground"}`}
                dir="auto"
              >
                {item.title}
              </div>
              {item.notes ? (
                <div className="mt-0.5 text-[12.5px] text-muted-foreground/80" dir="auto">
                  {item.notes}
                </div>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t`Remove`}
              disabled={busy}
              onClick={() => void removeItem(item)}
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
              void addItem();
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
            <Button
              variant="secondary"
              className="rounded-full"
              disabled={busy || !draft.trim()}
              onClick={() => void addItem()}
            >
              <Trans>Add</Trans>
            </Button>
          </form>
        ) : null}
      </div>
      {error ? <div className="mt-2 text-[13px] text-destructive">{error}</div> : null}
    </div>
  );
}
