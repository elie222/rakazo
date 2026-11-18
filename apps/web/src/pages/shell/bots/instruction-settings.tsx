import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { Bot } from "@rakazo/contracts";
import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import { Button, Disclosure, Textarea } from "@rakazo/ui-web";
import { Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web/components/ui/popover";
import { History } from "lucide-react";
import { useId, useState } from "react";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";

type Change = { kind: "edit" } | { kind: "restore"; versionId: string } | { kind: "reload" };

export function InstructionSettings({ bot }: { bot: Bot }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const id = useId();
  const [previousBot, setPreviousBot] = useState(bot);
  const [current, setCurrent] = useState(bot);
  const [baseline, setBaseline] = useState(bot.instructions);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [conflict, setConflict] = useState(false);
  if (bot !== previousBot) {
    setPreviousBot(bot);
    if (instructions === baseline) {
      setInstructions(bot.instructions);
      setBaseline(bot.instructions);
    }
    setCurrent(bot);
  }
  const change = useSave({
    save: (input: Change, rpc) =>
      input.kind === "restore"
        ? rpc.bots.restoreInstructions({
            botId: bot.id,
            versionId: input.versionId,
            expectedInstructions: current.instructions,
          })
        : input.kind === "reload"
          ? rpc.bots.get({ botId: bot.id })
          : rpc.bots.update({ botId: bot.id, instructions, expectedInstructions: baseline }),
    stale: (input) => (input.kind === "reload" ? [] : [queries.bots.list.key()]),
    onSaved: (updated) => {
      setConflict(false);
      setCurrent(updated);
      setInstructions(updated.instructions);
      setBaseline(updated.instructions);
    },
    onFailed: (error) => {
      if (error instanceof ORPCError && error.code === "CONFLICT") setConflict(true);
    },
  });
  const pending = change.pending;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between pe-1">
        <label
          htmlFor={`${id}-instructions`}
          className="text-label font-medium text-muted-foreground"
        >
          <Trans>Instructions</Trans>
        </label>
        {current.instructionHistory?.length ? (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t`Instruction history`}
                  title={t`Instruction history`}
                />
              }
            >
              <History className="size-4 text-muted-foreground" />
            </PopoverTrigger>
            <PopoverContent align="end" className="max-h-96 overflow-y-auto">
              {current.instructionHistory.map((version) => (
                <div key={version.id} className="mt-2 text-body">
                  <Disclosure
                    summary={
                      <span className="inline-flex flex-wrap gap-x-2">
                        <span>{new Date(version.createdAt).toLocaleString()}</span>
                        <span className="text-muted-foreground">{version.reason}</span>
                      </span>
                    }
                  >
                    <pre className="whitespace-pre-wrap">{version.instructions}</pre>
                  </Disclosure>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => change.run({ kind: "restore", versionId: version.id })}
                  >
                    <Trans>Restore</Trans>
                  </Button>
                </div>
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
      <Textarea
        id={`${id}-instructions`}
        className="min-h-20 max-h-96 resize-none field-sizing-content"
        value={instructions}
        maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
        disabled={pending}
        onChange={(event) => setInstructions(event.target.value)}
        onBlur={() => {
          if (!conflict && instructions !== current.instructions) change.run({ kind: "edit" });
        }}
      />
      {change.error ? (
        <p className="text-body text-destructive">{errorText(change.error)}</p>
      ) : null}
      {conflict ? (
        <Button variant="outline" disabled={pending} onClick={() => change.run({ kind: "reload" })}>
          <Trans>Reload</Trans>
        </Button>
      ) : null}
    </div>
  );
}
