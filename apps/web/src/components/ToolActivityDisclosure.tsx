import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage, ToolStep } from "@rakazo/contracts";
import type { ToolStepStatus } from "@rakazo/core";
import {
  formatCompactDuration,
  formatElapsedSince,
  LIVE_TOOL_STEP_WINDOW,
  pickToolCallRecord,
  toolCallMarkdown,
  toolCallReadIsFinal,
  toolStepStatus,
} from "@rakazo/core";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useEffect, useState, useSyncExternalStore } from "react";
import { useSpaceQueries } from "../lib/query";
import { toolStepCount } from "../lib/tool-activity-view";
import { liveToolCallRecords, subscribeToolCallRecords } from "../lib/tool-call-records";

/** Where a step's result lives: the run's records, read when the row opens. */
export type ToolStepSource = { threadId: string; runId: string };

export function ToolSteps({
  steps,
  live = false,
  limit,
  source,
}: {
  steps: readonly ToolStep[];
  /** The run is still going: a step without a result is running. */
  live?: boolean;
  /** Show only the last `limit` steps, with a count of the earlier ones above them. */
  limit?: number;
  source?: ToolStepSource;
}) {
  const hidden = limit !== undefined && steps.length > limit ? steps.length - limit : 0;
  const shown = hidden > 0 ? steps.slice(hidden) : steps;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <div className="space-y-0.5" data-testid="tool-rows">
      {hidden > 0 ? (
        <div className="text-label leading-5 text-muted-foreground" data-testid="tool-rows-hidden">
          <Plural value={hidden} one="+# earlier step" other="+# earlier steps" />
        </div>
      ) : null}
      {shown.map((step, offset) => {
        const index = hidden + offset;
        // Rows keyed by their place in the block, which a repeated call joining the row or the
        // live window sliding past it never changes, so an open row stays open.
        const key = `step-${index}`;
        const expanded = open.has(key);
        const expandable = Boolean(step.executionId && source);
        return (
          <Fragment key={key}>
            {step.note ? (
              <div className="py-1 text-body-sm text-foreground/75" data-testid="tool-step-note">
                <ChatMarkdown>{step.note}</ChatMarkdown>
              </div>
            ) : null}
            <ToolStepRow
              step={step}
              status={toolStepStatus(step, live)}
              expanded={expandable ? expanded : undefined}
              onToggle={
                expandable
                  ? () =>
                      setOpen((prev) => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })
                  : undefined
              }
            />
            {expanded && expandable && source && step.executionId ? (
              <ToolStepDetail
                step={step}
                executionId={step.executionId}
                source={source}
                status={toolStepStatus(step, live)}
                runLive={live}
              />
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

function ToolStepRow({
  step,
  status,
  expanded,
  onToggle,
}: {
  step: ToolStep;
  status: ToolStepStatus;
  /** Undefined when the row has no result to open. */
  expanded: boolean | undefined;
  onToggle: (() => void) | undefined;
}) {
  const running = status === "running";
  const duration = running ? null : formatCompactDuration(step.durationMs);
  const content = (
    <>
      <span
        className={`w-3 shrink-0 text-center text-label ${
          status === "error" ? "text-destructive" : running ? "text-warning" : "text-success"
        }`}
        style={{ animation: running ? "rkPulse 1.2s ease-in-out infinite" : undefined }}
        role="img"
        aria-label={status === "error" ? t`Failed` : running ? t`Running` : t`Done`}
      >
        {status === "error" ? "✕" : running ? "◷" : "✓"}
      </span>
      <span
        className={`min-w-0 truncate text-body-sm ${running ? "text-foreground" : "text-muted-foreground"}`}
        title={step.label}
      >
        {step.label}
        {step.count > 1 ? ` ×${step.count}` : ""}
      </span>
      {step.detail ? (
        <span
          className="min-w-0 flex-1 truncate font-mono text-label text-muted-foreground/80"
          title={step.detail}
          dir="ltr"
          data-testid="tool-step-detail-line"
        >
          {step.detail}
        </span>
      ) : null}
      {duration ? (
        <span className="ms-auto shrink-0 ps-2 font-mono text-caption text-muted-foreground/70">
          {duration}
        </span>
      ) : null}
    </>
  );
  if (!onToggle) {
    return (
      <div className="flex min-w-0 items-center gap-2 leading-5" data-testid="tool-step">
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid="tool-step"
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md text-start leading-5 outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {content}
    </button>
  );
}

/** The record for one call: live from the thread's events, else read from the run's; see pickToolCallRecord. */
function useToolCallRecord(source: ToolStepSource, executionId: string, runLive: boolean) {
  const live = useSyncExternalStore(subscribeToolCallRecords, () =>
    liveToolCallRecords(source.runId),
  )?.get(executionId);
  const queries = useSpaceQueries();
  const needsRead = pickToolCallRecord(live, undefined, runLive).needsRead;
  const fetched = useQuery({
    ...queries.threads.toolCalls.queryOptions({ input: source }),
    enabled: needsRead,
    // A live run's calls keep changing; a finished run's are read once for all its steps.
    staleTime: (query) =>
      !runLive && toolCallReadIsFinal(query.state.data, executionId) ? Number.POSITIVE_INFINITY : 0,
  });
  const read = fetched.data?.find((item) => item.executionId === executionId);
  const { record } = pickToolCallRecord(live, read, runLive);
  return { record, loading: live === undefined && fetched.isPending, failed: fetched.isError };
}

/**
 * The call opened: a line naming it, the chat's own code block with what it ran and what came
 * back (following live while a shell command runs), and the exit code or error under it.
 */
function ToolStepDetail({
  step,
  executionId,
  source,
  status,
  runLive,
}: {
  step: ToolStep;
  executionId: string;
  source: ToolStepSource;
  status: ToolStepStatus;
  /** The run is still going, so the thread's events keep this call's record current. */
  runLive: boolean;
}) {
  const { record, loading, failed } = useToolCallRecord(source, executionId, runLive);
  const running = record?.status === "running" || status === "running";
  const markdown = record ? toolCallMarkdown(record) : "";
  const exit =
    record?.exitCode === undefined || record.exitCode === null ? null : t`exit ${record.exitCode}`;
  const duration = formatCompactDuration(record?.durationMs ?? step.durationMs);
  const dot = status === "error" ? "bg-destructive" : running ? "bg-warning" : "bg-success";
  return (
    <div data-testid="tool-step-panel" dir="ltr" className="my-1.5 min-w-0 space-y-1.5">
      <div className="flex items-center gap-2 text-label text-muted-foreground">
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${dot}`}
          style={{ animation: running ? "rkPulse 1.2s ease-in-out infinite" : undefined }}
        />
        <span className="shrink-0">{step.label}</span>
        {record?.command === undefined && step.detail ? (
          <span className="min-w-0 flex-1 truncate font-mono">{step.detail}</span>
        ) : null}
      </div>
      {markdown ? (
        <div className="max-h-80 overflow-y-auto" data-testid="tool-step-code">
          <ChatMarkdown streaming={running}>{markdown}</ChatMarkdown>
        </div>
      ) : record?.error || exit || running || record?.withheld ? null : (
        <div className="text-label text-muted-foreground" data-testid="tool-step-empty">
          {loading ? (
            <Trans>Loading…</Trans>
          ) : failed ? (
            <Trans>Couldn’t load this step.</Trans>
          ) : (
            <Trans>No output recorded.</Trans>
          )}
        </div>
      )}
      {record?.error || exit || duration ? (
        <div className="flex flex-wrap gap-x-3 font-mono text-caption text-muted-foreground">
          {record?.error ? (
            <span className="min-w-0 break-words text-destructive" data-testid="tool-step-error">
              {record.error}
            </span>
          ) : null}
          {exit ? <span data-testid="tool-step-exit">{exit}</span> : null}
          {duration ? <span>{duration}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Time since the run's first visible activity, ticking while it is live. */
function LiveElapsed({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = formatElapsedSince(startedAt, now);
  if (elapsed === null) return null;
  return (
    <span className="tabular-nums" data-testid="tool-activity-elapsed">
      {elapsed}
    </span>
  );
}

/**
 * The tool-activity card. It starts open while the run is live and folds when the run
 * ends. The keyed default keeps manual toggles until the run changes phase.
 */
export function ToolActivityDisclosure({
  live,
  stepCount,
  durationMs,
  startedAt,
  children,
}: {
  live: boolean;
  stepCount: number;
  durationMs?: number;
  /** When the live run's first activity showed; the header counts up from it. */
  startedAt?: string;
  children: ReactNode;
}) {
  const duration = formatCompactDuration(durationMs);
  const toolCount = stepCount;
  return (
    <Collapsible
      key={live ? "working" : "actions"}
      defaultOpen={live}
      data-testid="tool-activity"
      data-live={live || undefined}
      className="group"
    >
      <CollapsibleTrigger
        className={`flex min-h-6 w-fit cursor-pointer list-none items-center gap-1 rounded-md py-0.5 pe-1.5 text-body-sm font-medium outline-none hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
          live ? "text-foreground/75" : "text-muted-foreground"
        }`}
      >
        <ChevronRight
          aria-hidden
          size={14}
          strokeWidth={1.8}
          className="transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="flex items-center gap-2">
          <span>{live ? <Trans>Working…</Trans> : <Trans>Done</Trans>}</span>
          <span>
            <Plural value={toolCount} one="# tool" other="# tools" />
          </span>
          {live && startedAt ? <LiveElapsed startedAt={startedAt} /> : null}
          {!live && duration ? <span>{duration}</span> : null}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent hiddenUntilFound>
        <div className="ms-[7px] mt-0.5 border-s border-border ps-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
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
  startedAt,
  source,
}: {
  live: boolean;
  steps: readonly ToolStep[];
  stepCount: number;
  durationMs?: number;
  startedAt?: string;
  source?: ToolStepSource;
}) {
  return (
    <div className="flex justify-start" dir="ltr" data-testid="tool-activity-line">
      <div className="w-full max-w-full min-w-0 ps-1">
        <ToolActivityDisclosure
          live={live}
          stepCount={stepCount}
          durationMs={durationMs}
          startedAt={startedAt}
        >
          <ToolSteps
            steps={steps}
            live={live}
            limit={live ? LIVE_TOOL_STEP_WINDOW : undefined}
            source={source}
          />
        </ToolActivityDisclosure>
      </div>
    </div>
  );
}

/** Where a message's steps can read their results from. */
export function toolStepSource(
  message: Pick<ThreadMessage, "threadId" | "runId">,
): ToolStepSource | undefined {
  return message.runId ? { threadId: message.threadId, runId: message.runId } : undefined;
}

/** A bot message whose only visible blocks are tool cards: one slim line per card, no bubble. */
export function ToolOnlyNarration({
  blocks,
  live,
  message,
}: {
  blocks: readonly ThreadMessage["blocks"][number][];
  live: boolean;
  message: Pick<ThreadMessage, "threadId" | "runId" | "createdAt">;
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
            startedAt={message.createdAt}
            source={toolStepSource(message)}
          />
        ) : null,
      )}
    </>
  );
}
