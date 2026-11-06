import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage, ToolCallRecord, ToolStep } from "@rakazo/contracts";
import { formatCompactDuration, prettyToolText } from "@rakazo/core";
import { Button } from "@rakazo/ui-web/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useCopyText } from "../lib/copy-text";
import { useSpaceQueries } from "../lib/query";
import type { ToolStepStatus } from "../lib/tool-activity-view";
import { toolStepCount, toolStepStatus } from "../lib/tool-activity-view";
import { liveToolCallRecords, subscribeToolCallRecords } from "../lib/tool-call-records";

/** While a run is live, only the most recent steps are listed so a long run does not push the chat down. */
export const LIVE_TOOL_STEP_WINDOW = 6;

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
        <div className="text-[12px] leading-5 text-muted-foreground" data-testid="tool-rows-hidden">
          <Plural value={hidden} one="+# earlier step" other="+# earlier steps" />
        </div>
      ) : null}
      {shown.map((step, offset) => {
        const index = hidden + offset;
        // Rows keyed by call so a row stays open while the live window slides past it.
        const key = step.executionId ?? `step-${index}`;
        const expanded = open.has(key);
        const expandable = Boolean(step.executionId && source);
        return (
          <Fragment key={key}>
            {step.note ? (
              <div className="py-1 text-[13px] text-foreground/75" data-testid="tool-step-note">
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
  status: ReturnType<typeof toolStepStatus>;
  /** Undefined when the row has no result to open. */
  expanded: boolean | undefined;
  onToggle: (() => void) | undefined;
}) {
  const running = status === "running";
  const duration = running ? null : formatCompactDuration(step.durationMs);
  const content = (
    <>
      <span
        className={`w-3 shrink-0 text-center text-[12px] ${
          status === "error" ? "text-destructive" : running ? "text-warning" : "text-success"
        }`}
        style={{ animation: running ? "rkPulse 1.2s ease-in-out infinite" : undefined }}
        role="img"
        aria-label={status === "error" ? t`Failed` : running ? t`Running` : t`Done`}
      >
        {status === "error" ? "✕" : running ? "◷" : "✓"}
      </span>
      <span
        className={`min-w-0 truncate text-[13px] ${running ? "text-foreground" : "text-muted-foreground"}`}
        title={step.label}
      >
        {step.label}
        {step.count > 1 ? ` ×${step.count}` : ""}
      </span>
      {step.detail ? (
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground/80"
          title={step.detail}
          dir="ltr"
          data-testid="tool-step-detail-line"
        >
          {step.detail}
        </span>
      ) : null}
      {duration ? (
        <span className="ms-auto shrink-0 ps-2 font-mono text-[11px] text-muted-foreground/70">
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

function useToolCallRecord(source: ToolStepSource, executionId: string) {
  const live = useSyncExternalStore(subscribeToolCallRecords, () =>
    liveToolCallRecords(source.runId),
  )?.get(executionId);
  const queries = useSpaceQueries();
  const fetched = useQuery({
    ...queries.threads.toolCalls.queryOptions({ input: source }),
    // The live records are newer than anything a read returns.
    enabled: live === undefined,
    staleTime: 0,
  });
  const record: ToolCallRecord | undefined =
    live ?? fetched.data?.find((item) => item.executionId === executionId);
  return { record, loading: live === undefined && fetched.isPending, failed: fetched.isError };
}

/**
 * The call as a code card: what ran in the header, its arguments and what came back below, and
 * the exit code or error at the foot. A shell command's output follows live.
 */
function ToolStepDetail({
  step,
  executionId,
  source,
  status,
}: {
  step: ToolStep;
  executionId: string;
  source: ToolStepSource;
  status: ToolStepStatus;
}) {
  const { record, loading, failed } = useToolCallRecord(source, executionId);
  const [copied, copy] = useCopyText();
  const [copiedOutput, copyOutput] = useCopyText();
  const outputRef = useRef<HTMLPreElement>(null);
  const output = prettyToolText(record?.output ?? "");
  const running = record?.status === "running" || status === "running";
  // Follow new output like a terminal, unless the reader scrolled up to look at something.
  useEffect(() => {
    const element = outputRef.current;
    if (!element) return;
    const nearEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    if (nearEnd) element.scrollTop = element.scrollHeight;
  }, [output]);
  const command = record?.command;
  const exit =
    record?.exitCode === undefined || record.exitCode === null ? null : t`exit ${record.exitCode}`;
  const duration = formatCompactDuration(record?.durationMs ?? step.durationMs);
  const dot = status === "error" ? "bg-destructive" : running ? "bg-warning" : "bg-success";
  return (
    <div
      data-testid="tool-step-panel"
      dir="ltr"
      className="my-1 min-w-0 overflow-hidden rounded-lg border border-border bg-background font-mono text-[12px] leading-5 text-foreground"
    >
      <div className="flex items-start gap-2 border-b border-border px-2.5 py-1.5">
        <span
          aria-hidden
          className={`mt-[7px] size-1.5 shrink-0 rounded-full ${dot}`}
          style={{ animation: running ? "rkPulse 1.2s ease-in-out infinite" : undefined }}
        />
        <span className="shrink-0 text-muted-foreground">{step.label}</span>
        {command ? (
          <code
            className="min-w-0 flex-1 whitespace-pre-wrap break-words"
            data-testid="tool-step-command"
          >
            {command}
          </code>
        ) : (
          <span className="min-w-0 flex-1 truncate text-muted-foreground/80">{step.detail}</span>
        )}
        {command ? (
          <Button
            variant="text"
            size="xs"
            className="-my-0.5 -me-1 shrink-0 font-sans font-normal text-muted-foreground"
            data-testid="tool-step-copy"
            onClick={() => copy(command)}
          >
            {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
          </Button>
        ) : null}
      </div>
      {record?.input ? (
        <pre
          data-testid="tool-step-input"
          className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-b border-border px-2.5 py-1.5 text-muted-foreground"
        >
          {record.input}
        </pre>
      ) : null}
      {output || running ? (
        <pre
          ref={outputRef}
          data-testid="tool-step-output"
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-2.5 py-1.5"
        >
          {output}
          {running ? (
            <span
              aria-hidden
              className="inline-block h-[1.1em] w-[0.55em] translate-y-[0.2em] bg-foreground/70 align-baseline"
              style={{ animation: "rkPulse 1s steps(2, start) infinite" }}
            />
          ) : null}
        </pre>
      ) : record?.error || exit ? null : (
        <div
          className="px-2.5 py-1.5 font-sans text-muted-foreground"
          data-testid="tool-step-empty"
        >
          {loading ? (
            <Trans>Loading…</Trans>
          ) : failed ? (
            <Trans>Couldn’t load this step.</Trans>
          ) : (
            <Trans>No output recorded.</Trans>
          )}
        </div>
      )}
      {record?.error || exit || duration || output ? (
        <div className="flex flex-wrap items-center gap-x-3 border-t border-border px-2.5 py-1 text-[11px] text-muted-foreground">
          {record?.error ? (
            <span className="min-w-0 break-words text-destructive" data-testid="tool-step-error">
              {record.error}
            </span>
          ) : null}
          {exit ? <span data-testid="tool-step-exit">{exit}</span> : null}
          {duration ? <span>{duration}</span> : null}
          {output ? (
            <Button
              variant="text"
              size="xs"
              className="-my-1 -me-1.5 ms-auto h-5 font-sans font-normal text-muted-foreground"
              data-testid="tool-step-copy-output"
              onClick={() => copyOutput(output)}
            >
              {copiedOutput ? <Trans>Copied</Trans> : <Trans>Copy output</Trans>}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Time since the run's first visible activity, ticking while it is live. */
function LiveElapsed({ startedAt }: { startedAt: string }) {
  const startedAtMs = Date.parse(startedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!Number.isFinite(startedAtMs)) return null;
  return (
    <span className="tabular-nums" data-testid="tool-activity-elapsed">
      {formatCompactDuration(Math.max(0, now - startedAtMs))}
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
        className={`flex min-h-6 w-fit cursor-pointer list-none items-center gap-1 rounded-md py-0.5 pe-1.5 text-[13px] font-medium outline-none hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
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
