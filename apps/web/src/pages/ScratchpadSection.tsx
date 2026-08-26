import { Trans, useLingui } from "@lingui/react/macro";
import type { ScratchpadItem } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { BuiButton } from "../components/beautiful-ui/primitives";
import { rpc } from "../lib/rpc";

export function ScratchpadSection({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [items, setItems] = useState<ScratchpadItem[]>([]);
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

  return (
    <div className="mt-6" data-testid="bot-scratchpad">
      <div className="mb-3 text-[14px] text-[#85858A]">
        <Trans>Open work</Trans>
      </div>
      {items.length === 0 ? (
        <div className="px-2.5 py-1 text-[13.5px] text-[#6C6C70]">
          <Trans>None yet</Trans>
        </div>
      ) : (
        items.map((item) => (
          <div
            key={item.id}
            className="flex w-full items-start gap-2 rounded-[11px] px-2.5 py-2.5 hover:bg-[#121214]"
          >
            <button
              type="button"
              aria-label={item.status === "done" ? t`Reopen` : t`Complete`}
              disabled={busy}
              onClick={() => void setStatus(item, item.status === "done" ? "open" : "done")}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border border-[#3A3A40] text-[10px] leading-none text-[#E65707]"
            >
              {item.status === "done" ? "✓" : ""}
            </button>
            <div className="min-w-0 flex-1">
              <div
                className={`text-start text-[14.5px] ${item.status === "done" ? "text-[#6C6C70] line-through" : "text-[#ECECEE]"}`}
                dir="auto"
              >
                {item.title}
              </div>
              {item.notes ? (
                <div className="mt-0.5 text-[12.5px] text-[#6C6C70]" dir="auto">
                  {item.notes}
                </div>
              ) : null}
            </div>
            <span className="shrink-0 text-[12px] text-[#6C6C70]">{item.status}</span>
            {item.status === "open" ? (
              <button
                type="button"
                aria-label={t`Park`}
                disabled={busy}
                onClick={() => void setStatus(item, "parked")}
                className="shrink-0 text-[12px] text-[#7A7A80]"
              >
                <Trans>Park</Trans>
              </button>
            ) : item.status === "parked" ? (
              <button
                type="button"
                aria-label={t`Reopen`}
                disabled={busy}
                onClick={() => void setStatus(item, "open")}
                className="shrink-0 text-[12px] text-[#7A7A80]"
              >
                <Trans>Open</Trans>
              </button>
            ) : null}
            <button
              type="button"
              aria-label={t`Remove`}
              disabled={busy}
              onClick={() => void removeItem(item)}
              className="shrink-0 text-[12px] text-[#7A7A80]"
            >
              ✕
            </button>
          </div>
        ))
      )}
      <form
        className="mt-2 flex items-center gap-2 px-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          void addItem();
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t`Add item`}
          aria-label={t`New open-work item`}
          maxLength={200}
          className="min-w-0 flex-1 rounded-[11px] border border-[#26262A] bg-transparent px-3 py-2 text-[14px] text-[#ECECEE] placeholder:text-[#55555A]"
        />
        <BuiButton disabled={busy || !draft.trim()} onClick={() => void addItem()}>
          <Trans>Add</Trans>
        </BuiButton>
      </form>
      {error ? <div className="mt-2 px-2.5 text-[13px] text-[#C45C5C]">{error}</div> : null}
    </div>
  );
}
