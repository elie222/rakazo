import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { GROK_BOT_EXPORT_PATH } from "@rakazo/contracts";
import type { GrokBot } from "@rakazo/core";
import { grokBotExportJson, newClientId } from "@rakazo/core";
import { Button, Checkbox, Label } from "@rakazo/ui-web";
import { Check, ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import { rpc } from "../../../lib/query/rpc";

/**
 * Every Bot in an export starts ticked and imports in one go with what a review ticks by
 * default; a Bot opened on its own gets the full review. When some are refused, the list
 * stays with the imported ones done and why each other one was not.
 */
export function GrokBotPicker({
  bots,
  busy,
  onReview,
  onCreatingChange,
  onImported,
  onError,
}: {
  bots: GrokBot[];
  busy: boolean;
  onReview: (bot: GrokBot) => void;
  onCreatingChange: (creating: boolean) => void;
  /** Once every picked Bot is in, with the first one made. */
  onImported: (first: Bot) => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useLingui();
  const [unpicked, setUnpicked] = useState<ReadonlySet<GrokBot>>(new Set());
  const [created, setCreated] = useState<ReadonlyMap<GrokBot, Bot>>(new Map());
  const [reasons, setReasons] = useState<ReadonlyMap<GrokBot, string>>(new Map());
  const [importing, setImporting] = useState(false);
  // One key per Bot, so a retried import returns the bot the first one made.
  const keys = useRef(new WeakMap<GrokBot, string>());
  const keyFor = (bot: GrokBot) => {
    const known = keys.current.get(bot);
    if (known) return known;
    const key = newClientId();
    keys.current.set(bot, key);
    return key;
  };
  const picked = bots.filter((bot) => !unpicked.has(bot) && !created.has(bot));

  async function importPicked() {
    setImporting(true);
    onCreatingChange(true);
    try {
      const results = await rpc.bots.importMany({
        agents: picked.map((bot) => ({
          importKey: keyFor(bot),
          files: [{ path: GROK_BOT_EXPORT_PATH, content: grokBotExportJson(bot) }],
        })),
      });
      const made = new Map(created);
      const failed = new Map<GrokBot, string>();
      results.forEach((result, index) => {
        const bot = picked[index]!;
        if ("bot" in result) made.set(bot, result.bot);
        else failed.set(bot, result.error);
      });
      setCreated(made);
      setReasons(failed);
      const first = bots.map((bot) => made.get(bot)).find(Boolean);
      if (failed.size === 0 && first) onImported(first);
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
        {bots.map((bot, index) => {
          const done = created.has(bot);
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
                    checked={!unpicked.has(bot)}
                    disabled={importing}
                    onCheckedChange={(checked) =>
                      setUnpicked((current) => {
                        const next = new Set(current);
                        if (checked) next.delete(bot);
                        else next.add(bot);
                        return next;
                      })
                    }
                  />
                )}
                <span className="min-w-0">
                  <span className="block truncate" dir="auto">
                    {bot.name}
                  </span>
                  {reasons.has(bot) ? (
                    <span className="block text-body-sm text-destructive">{reasons.get(bot)}</span>
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
      </div>
    </section>
  );
}
