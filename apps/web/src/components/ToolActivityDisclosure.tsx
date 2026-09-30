import { Plural } from "@lingui/react/macro";
import type { ThreadMessage } from "@rakazo/contracts";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { formatToolActivityDuration, toolStepCount } from "../lib/tool-activity-view";

type ToolStep = Extract<ThreadMessage["blocks"][number], { kind: "steps" }>["steps"][number];

/** While a run is live, only the most recent steps are listed so a long run does not push the chat down. */
export const LIVE_TOOL_STEP_WINDOW = 6;

export function ToolSteps({
  steps,
  currentIndex,
  limit,
}: {
  steps: readonly ToolStep[];
  currentIndex?: number;
  /** Show only the last `limit` steps, with a count of the earlier ones above them. */
  limit?: number;
}) {
  const hidden = limit !== undefined && steps.length > limit ? steps.length - limit : 0;
  const shown = hidden > 0 ? steps.slice(hidden) : steps;
  return (
    <div className="space-y-0.5" data-testid="tool-rows">
      {hidden > 0 ? (
        <div className="text-[12px] leading-5 text-muted-foreground" data-testid="tool-rows-hidden">
          <Plural value={hidden} one="+# earlier step" other="+# earlier steps" />
        </div>
      ) : null}
      {shown.map((step, offset) => {
        const index = hidden + offset;
        const isCurrent = index === currentIndex;
        return (
          <div key={index} className="flex min-w-0 items-center gap-2 leading-5">
            <span
              className={`text-[12px] ${isCurrent ? "text-warning" : "text-success"}`}
              style={{ animation: isCurrent ? "rkPulse 1.2s ease-in-out infinite" : undefined }}
            >
              {isCurrent ? "◷" : "✓"}
            </span>
            <span
              className={`min-w-0 flex-1 truncate text-[13px] ${
                isCurrent ? "text-foreground" : "text-muted-foreground"
              }`}
              title={step.label}
            >
              {step.label}
              {step.count > 1 ? ` ×${step.count}` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The tool-activity card. It starts open while the run is live and folds when the run
 * ends: the `key` swap remounts the element, so `open` restarts from `live`. A manual
 * collapse during the run holds, because React only rewrites `open` when the prop
 * changes, and it stays `true` for the whole run.
 */
export function ToolActivityDisclosure({
  live,
  stepCount,
  durationMs,
  children,
}: {
  live: boolean;
  stepCount: number;
  durationMs?: number;
  children: ReactNode;
}) {
  const duration = formatToolActivityDuration(durationMs);
  return (
    <details
      key={live ? "working" : "actions"}
      open={live}
      data-testid="tool-activity"
      data-live={live || undefined}
      className="group"
    >
      <summary
        className={`flex min-h-6 w-fit cursor-pointer list-none items-center gap-1 rounded-md py-0.5 pe-1.5 text-[13px] font-medium outline-none hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
          live ? "text-foreground/75" : "text-muted-foreground"
        }`}
      >
        <ChevronRight
          aria-hidden
          size={14}
          strokeWidth={1.8}
          className="transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
        />
        {live ? (
          <Plural value={stepCount} one="Working… · # tool" other="Working… · # tools" />
        ) : (
          <>
            <Plural value={stepCount} one="Done · # tool" other="Done · # tools" />
            {duration ? ` · ${duration}` : null}
          </>
        )}
      </summary>
      <div className="ms-[7px] mt-0.5 border-s border-border ps-3">{children}</div>
    </details>
  );
}

/**
 * A tools-only message: a plain muted line between messages, not a chat bubble.
 */
export function StandaloneToolActivity({
  live,
  steps,
  stepCount,
  durationMs,
}: {
  live: boolean;
  steps: readonly ToolStep[];
  stepCount: number;
  durationMs?: number;
}) {
  return (
    <div className="flex justify-start" dir="ltr" data-testid="tool-activity-line">
      <div className="max-w-[74%] min-w-0 ps-1">
        <ToolActivityDisclosure live={live} stepCount={stepCount} durationMs={durationMs}>
          <ToolSteps
            steps={steps}
            currentIndex={live ? steps.length - 1 : undefined}
            limit={live ? LIVE_TOOL_STEP_WINDOW : undefined}
          />
        </ToolActivityDisclosure>
      </div>
    </div>
  );
}

/** A bot message whose only visible blocks are tool cards: one slim line per card, no bubble. */
export function ToolOnlyNarration({
  blocks,
  live,
}: {
  blocks: readonly ThreadMessage["blocks"][number][];
  live: boolean;
}) {
  return (
    <>
      {blocks.map((block, i) =>
        block.kind === "steps" ? (
          <StandaloneToolActivity
            key={i}
            live={live}
            steps={block.steps}
            stepCount={toolStepCount(block.steps)}
            durationMs={block.durationMs}
          />
        ) : null,
      )}
    </>
  );
}
