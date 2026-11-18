import { Trans } from "@lingui/react/macro";
import type { ToolCallRecord } from "@rakazo/contracts";
import { formatCompactDuration, formatFileSize } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../../lib/query/query";

const NO_CALLS: ToolCallRecord[] = [];

/**
 * The calls worth explaining after a run: the ones that failed, and the ones whose result came back
 * cut short. A call that just worked needs no line of its own.
 */
export function callsToExplain(calls: readonly ToolCallRecord[]): ToolCallRecord[] {
  return calls.filter((call) => call.outcome === "failed" || call.resultShortened);
}

/**
 * Why a run's tool calls went the way they did, under the run's own step list. It shows only the
 * calls that need explaining, so a run that worked leaves no trace here.
 */
export function ToolCallExplanations({ calls }: { calls: readonly ToolCallRecord[] }) {
  const explained = callsToExplain(calls);
  if (explained.length === 0) return null;
  return (
    <div
      className="mt-2 space-y-2 border-t border-border pt-2"
      data-testid="tool-call-explanations"
    >
      {explained.map((call) => {
        const duration = formatCompactDuration(call.durationMs);
        return (
          <div key={call.executionId} className="space-y-0.5 text-label leading-5">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="min-w-0 truncate text-foreground/75" title={call.tool}>
                {call.tool}
              </span>
              {call.outcome === "failed" ? (
                <span className="text-destructive">
                  <Trans>Failed</Trans>
                </span>
              ) : null}
              {duration ? <span className="text-muted-foreground/80">{duration}</span> : null}
            </div>
            {call.arguments ? (
              <p className="line-clamp-2 break-all text-muted-foreground">{call.arguments}</p>
            ) : null}
            {call.error ? (
              <p className="whitespace-pre-wrap break-words text-destructive/90">{call.error}</p>
            ) : null}
            {call.outcome === "failed" && call.resultHead ? (
              <p className="line-clamp-3 break-words text-muted-foreground">{call.resultHead}</p>
            ) : null}
            {call.resultShortened ? (
              <p className="text-muted-foreground">
                <Trans>Result shortened</Trans>
                {call.resultBytes === undefined ? null : ` ${formatFileSize(call.resultBytes)}`}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Reads one run's kept tool call records. Nothing shows while they load, when the run kept none,
 * or for anyone but the run's owner, whom the server refuses.
 */
export function RunToolCallDetails({ runId }: { runId: string }) {
  const queries = useSpaceQueries();
  const records = useQuery(queries.runs.toolCalls.queryOptions({ input: { runId } }));
  return <ToolCallExplanations calls={records.data?.calls ?? NO_CALLS} />;
}
