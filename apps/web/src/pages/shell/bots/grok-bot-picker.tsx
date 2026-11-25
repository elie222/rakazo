import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { GROK_BOT_EXPORT_MAX_LENGTH, GROK_BOT_EXPORT_PATH } from "@rakazo/contracts";
import type { GrokBot } from "@rakazo/core";
import { AGENT_IMPORT_NOT_FOUND, grokBotExportJson, newClientId } from "@rakazo/core";
import { Button, Checkbox, Label } from "@rakazo/ui-web";
import { Check, ChevronRight } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useMemo, useState } from "react";
import { agentImportErrorText, grokBotErrorText } from "../../../lib/bots/agent-import-errors";
import { rpc } from "../../../lib/query/rpc";
import type { GrokBatch } from "./use-agent-import-source";

/** The same localized words a single import shows for this refusal. */
function refusalText(result: { error: string; data?: Record<string, unknown> }): string {
  if (result.error === AGENT_IMPORT_NOT_FOUND) return grokBotErrorText("not_export");
  return agentImportErrorText(result) ?? result.error;
}

/**
 * Every Bot in an export starts ticked and imports in one go with what a review ticks by
 * default; a Bot opened on its own gets the full review. When some are refused, the list
 * stays with the imported ones done and why each other one was not.
 */
export function GrokBotPicker({
  bots,
  batch,
  setBatch,
  keys,
  busy,
  onReview,
  onCreatingChange,
  onImported,
  onError,
}: {
  bots: GrokBot[];
  batch: GrokBatch;
  setBatch: Dispatch<SetStateAction<GrokBatch>>;
  /** One import key per Bot's export text, so a retried import returns the bot it made. */
  keys: RefObject<Map<string, string>>;
  busy: boolean;
  onReview: (bot: GrokBot) => void;
  onCreatingChange: (creating: boolean) => void;
  /** Once the import is finished, with the first bot it made. */
  onImported: (first: Bot) => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useLingui();
  const [importing, setImporting] = useState(false);
  const rows = useMemo(() => bots.map((bot) => ({ bot, id: grokBotExportJson(bot) })), [bots]);
  const picked = rows.filter(({ id }) => !batch.unpicked.has(id) && !batch.created.has(id));
  const first = rows.map(({ id }) => batch.created.get(id)).find(Boolean);

  async function importPicked() {
    const keyFor = (id: string) => {
      const known = keys.current.get(id);
      if (known) return known;
      const key = newClientId();
      keys.current.set(id, key);
      return key;
    };
    const reasons = new Map<string, string>();
    const sent = picked.filter(({ id }) => {
      if (id.length <= GROK_BOT_EXPORT_MAX_LENGTH) return true;
      reasons.set(id, grokBotErrorText("too_large"));
      return false;
    });
    setImporting(true);
    onCreatingChange(true);
    try {
      const results = sent.length
        ? await rpc.bots.importMany({
            agents: sent.map(({ id }) => ({
              importKey: keyFor(id),
              files: [{ path: GROK_BOT_EXPORT_PATH, content: id }],
            })),
          })
        : [];
      const created = new Map(batch.created);
      results.forEach((result, index) => {
        const { id } = sent[index]!;
        if ("bot" in result) created.set(id, result.bot);
        else reasons.set(id, refusalText(result));
      });
      setBatch((current) => ({ ...current, created, reasons }));
      const made = rows.map(({ id }) => created.get(id)).find(Boolean);
      if (reasons.size === 0 && made) onImported(made);
    } catch (err) {
      onError(err);
    } finally {
      setImporting(false);
      onCreatingChange(false);
    }
  }

  return (
    <section data-testid="agent-import-grok-bots" className="mt-5">
      <ul className="divide-y divide-border/60">
        {rows.map(({ bot, id }, index) => {
          const done = batch.created.has(id);
          const reason = batch.reasons.get(id);
          return (
            <li
              key={`${bot.exportId ?? bot.name}:${index}`}
              className="flex items-center gap-3 py-1"
            >
              <Label className="min-h-9 min-w-0 flex-1 gap-3 font-normal text-body text-foreground">
                {done ? (
                  <Check
                    aria-label={t`Imported`}
                    size={16}
                    strokeWidth={1.8}
                    className="shrink-0 text-success"
                  />
                ) : (
                  <Checkbox
                    checked={!batch.unpicked.has(id)}
                    disabled={importing}
                    onCheckedChange={(checked) =>
                      setBatch((current) => {
                        const unpicked = new Set(current.unpicked);
                        if (checked) unpicked.delete(id);
                        else unpicked.add(id);
                        return { ...current, unpicked };
                      })
                    }
                  />
                )}
                <span className="min-w-0">
                  <span className="block truncate" dir="auto">
                    {bot.name}
                  </span>
                  {reason ? (
                    <span className="block text-body-sm text-destructive">{reason}</span>
                  ) : null}
                </span>
              </Label>
              {done ? null : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`Review ${bot.name}`}
                  disabled={busy || importing}
                  onClick={() => onReview(bot)}
                >
                  <ChevronRight size={16} strokeWidth={1.8} className="rtl:rotate-180" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-4 flex justify-end">
        {picked.length === 0 && first ? (
          <Button onClick={() => onImported(first)}>
            <Trans>Done</Trans>
          </Button>
        ) : (
          <Button
            data-testid="agent-import-grok-import"
            disabled={busy || importing || picked.length === 0}
            onClick={() => void importPicked()}
          >
            {importing ? (
              <Trans>Importing…</Trans>
            ) : (
              <Plural value={picked.length} one="Import # Bot" other="Import # Bots" />
            )}
          </Button>
        )}
      </div>
    </section>
  );
}
