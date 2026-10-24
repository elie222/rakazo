import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useImportStatusText } from "./import-status";

/** Where a setup item is finished: model connections, MCP servers, or the routine itself. */
export type ImportSetupTarget =
  | { kind: "models" }
  | { kind: "mcp" }
  | { kind: "routine"; routineId: string };

/**
 * The one checklist an agent import posts in the bot's chat: each imported item that still
 * needs something, and a way to the place that finishes it. MCP servers are still granted
 * through their approval cards.
 */
export function ImportSetupCard({
  block,
  onOpen,
}: {
  block: Extract<MessageBlock, { kind: "import_setup" }>;
  onOpen?: (target: ImportSetupTarget) => void;
}) {
  const { t } = useLingui();
  const text = useImportStatusText();
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
            <li key={`${index}:${name}`} className="flex min-h-11 items-center gap-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] text-foreground" dir="auto">
                  {name}
                </p>
                <p className="text-[12.5px] text-muted-foreground" dir="auto">
                  {detail}
                </p>
              </div>
              {target && onOpen ? (
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
