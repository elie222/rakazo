import { Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

type SubagentBlock = Extract<ThreadMessage["blocks"][number], { kind: "subagent" }>;

/**
 * A helper's card. It starts folded to its name, status and one line of the task, so a long
 * brief or report does not fill the chat. The header opens it to the full task and the result
 * or progress.
 */
export function SubagentCard({ block }: { block: SubagentBlock }) {
  const [open, setOpen] = useState(false);
  const running = block.status === "running";
  const failed = block.status === "failed";
  const body = block.result || block.progress || "";
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid="subagent-card"
      className="w-[420px] max-w-full rounded-[18px] border border-border bg-muted px-[18px] py-4"
    >
      <CollapsibleTrigger className="block w-full min-w-0 cursor-pointer rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-muted">
        <span className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1 text-[15px] font-medium text-foreground">
            <ChevronRight
              aria-hidden
              size={14}
              strokeWidth={1.8}
              className={`shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${
                open ? "rotate-90" : ""
              }`}
            />
            <span className="truncate" dir="auto">
              {block.name}
            </span>
          </span>
          <span
            className={`shrink-0 rounded-full px-[11px] py-1 text-[13px] ${
              failed
                ? "bg-destructive/15 text-destructive"
                : running
                  ? "bg-warning/15 text-warning"
                  : "bg-success/15 text-success"
            }`}
            style={{
              animation: running ? "rkPulse 1.2s ease-in-out infinite" : undefined,
            }}
          >
            {running ? <Trans>subagent</Trans> : block.status}
          </span>
        </span>
        <span
          data-testid="subagent-task"
          className={`mt-2 block text-[13.5px] text-muted-foreground ${open ? "" : "truncate"}`}
          dir="auto"
        >
          {block.task}
        </span>
      </CollapsibleTrigger>
      {body ? (
        <CollapsibleContent>
          <div
            data-testid="subagent-body"
            className="mt-2.5 text-[14.5px] leading-[1.5] text-foreground/75"
          >
            <ChatMarkdown streaming={running}>{body}</ChatMarkdown>
          </div>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
