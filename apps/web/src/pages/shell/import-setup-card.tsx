import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentImportSetupItem, AgentImportSetupState, MessageBlock } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { SuccessPop } from "../../components/ai/primitives";
import { rpc } from "../../lib/rpc";
import { useImportStatusText } from "./import-status";

/** Where a setup item is finished: model connections, MCP servers, or the routine itself. */
export type ImportSetupTarget =
  | { kind: "models" }
  | { kind: "mcp" }
  | { kind: "routine"; routineId: string };

/** Done now, not done, or (a skill's needs) only for information. */
function isDone(item: AgentImportSetupItem, state: AgentImportSetupState | null) {
  if (!state || item.kind === "skill") return null;
  if (item.kind === "model") return state.providers[item.provider] === true;
  if (item.kind === "mcp") return state.serverIds[item.serverId] === true;
  return state.routineIds[item.routineId] === true;
}

/**
 * The one checklist an agent import posts in the bot's chat: each imported item that still
 * needs something, and a way to the place that finishes it. Whether each item is done is read
 * from current data when the card is shown and whenever the thread is refreshed; with
 * everything done the card shrinks to one line. MCP servers are still granted through their
 * approval cards.
 */
export function ImportSetupCard({
  botId,
  block,
  onOpen,
}: {
  botId?: string;
  block: Extract<MessageBlock, { kind: "import_setup" }>;
  onOpen?: (target: ImportSetupTarget) => void;
}) {
  const { t } = useLingui();
  const text = useImportStatusText();
  const [state, setState] = useState<AgentImportSetupState | null>(null);

  // `block` is a new object each time the thread is fetched again, so this follows refreshes.
  useEffect(() => {
    if (!botId) return;
    let current = true;
    const kinds = <K extends AgentImportSetupItem["kind"]>(kind: K) =>
      block.items.filter(
        (item): item is Extract<AgentImportSetupItem, { kind: K }> => item.kind === kind,
      );
    rpc.bots
      .importSetupState({
        botId,
        providers: kinds("model").map((item) => item.provider),
        serverIds: kinds("mcp").map((item) => item.serverId),
        routineIds: kinds("routine").map((item) => item.routineId),
      })
      .then((next) => {
        if (current) setState(next);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [botId, block]);

  const tracked = block.items.filter((item) => item.kind !== "skill");
  if (state && tracked.length > 0 && tracked.every((item) => isDone(item, state))) {
    return (
      <div
        data-testid="import-setup-card"
        data-complete="true"
        className="w-[420px] max-w-full rounded-[20px] bg-card px-[18px] py-[14px] text-[14px] text-foreground"
      >
        <SuccessPop label={t`Setup complete`} />
      </div>
    );
  }

  return (
    <div
      data-testid="import-setup-card"
      className="w-[420px] max-w-full rounded-[20px] bg-card px-[18px] py-[14px]"
    >
      <p className="text-[15.5px] text-foreground/90">
        <Trans>Finish setting up</Trans>
      </p>
      <ul className="mt-2 divide-y divide-border">
        {block.items.map((item, index) => {
          const name = item.kind === "model" ? item.title : item.name;
          const done = isDone(item, state);
          const detail =
            item.kind === "model"
              ? text.need({ kind: "api_key", provider: item.providerName ?? item.provider })
              : item.kind === "routine"
                ? text.need({ kind: "turn_on" })
                : item.needs.map(text.need).join(" · ");
          const target: ImportSetupTarget | null =
            item.kind === "model"
              ? { kind: "models" }
              : item.kind === "mcp"
                ? { kind: "mcp" }
                : item.kind === "routine"
                  ? { kind: "routine", routineId: item.routineId }
                  : null;
          return (
            <li
              key={`${index}:${name}`}
              data-done={done === true ? "true" : undefined}
              className="flex min-h-11 items-center gap-3 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] text-foreground" dir="auto">
                  {name}
                </p>
                <p className="text-[12.5px] text-muted-foreground" dir="auto">
                  {detail}
                </p>
              </div>
              {done ? (
                <Check
                  role="img"
                  aria-label={t`Done`}
                  size={16}
                  strokeWidth={2}
                  className="shrink-0 text-success"
                />
              ) : target && onOpen ? (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={t`Open ${name}`}
                  onClick={() => onOpen(target)}
                >
                  <Trans>Open</Trans>
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
