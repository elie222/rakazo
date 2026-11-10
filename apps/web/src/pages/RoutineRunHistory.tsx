import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { MessageBlock, RoutineRun, RoutineRunCursor } from "@rakazo/contracts";
import {
  formatRoutineRunAt,
  isRetryableError,
  mergeRoutineRunPages,
  normalizeRunError,
  routineHistoryPage,
  routineRunAt,
  routineRunLateness,
} from "@rakazo/core";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  SectionHeading,
  Spinner,
} from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { ToolActivityDisclosure, ToolSteps } from "../components/ToolActivityDisclosure";
import { useSpaceQueries } from "../lib/query";
import { translateRunError } from "../lib/run-error";
import { toolStepCount } from "../lib/tool-activity-view";
import { statusLabel, statusTone } from "./ActivityList";

export function RoutineRunHistory({ routineId }: { routineId: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const history = useInfiniteQuery(
    queries.routines.history.infiniteOptions({
      input: (before: RoutineRunCursor | null) => routineHistoryPage(routineId, before),
      initialPageParam: null as RoutineRunCursor | null,
      getNextPageParam: (page) => page.nextCursor,
      // Polls every loaded page together so they stay one coherent list; a refused request stops.
      refetchInterval: (query) =>
        query.state.error && !isRetryableError(query.state.error) ? false : 15_000,
    }),
  );
  const runs = history.data ? mergeRoutineRunPages(history.data.pages) : null;
  // A routine that has never run has no history to show.
  if (runs?.length === 0 && !history.isError) return null;

  return (
    <section data-testid="routine-run-history" className="mt-10 text-body text-muted-foreground">
      <SectionHeading>
        <Trans>Run history</Trans>
      </SectionHeading>
      {history.isError ? (
        <p role="alert" className="mt-2 text-body text-destructive">
          <Trans>Could not load run history</Trans>
        </p>
      ) : null}
      {runs === null ? (
        history.isPending ? (
          <p className="mt-2 text-body">
            <Spinner aria-label={t`Loading…`} />
          </p>
        ) : null
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ul>
      )}
      {history.hasNextPage ? (
        <Button
          variant="text"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
          className="mt-1 font-normal"
        >
          <Trans>Load older runs</Trans>
        </Button>
      ) : null}
    </section>
  );
}

function RunRow({ run }: { run: RoutineRun }) {
  const { i18n, t } = useLingui();
  const locale = i18n.locale || "en";
  const at = routineRunAt(run);
  const late = routineRunLateness(run);
  const count = late?.count;
  const lateLabel = !late
    ? null
    : late.unit === "minutes"
      ? t`Started ${count}m late`
      : late.unit === "hours"
        ? t`Started ${count}h late`
        : t`Started ${count}d late`;
  // A silent run kept its reply out of the chat, so the row opens it here instead.
  const reply = run.reply?.length ? run.reply : null;
  const chatTo =
    !reply && run.messageId
      ? run.groupId
        ? `/app/g/${encodeURIComponent(run.groupId)}?m=${encodeURIComponent(run.messageId)}`
        : `/app/${encodeURIComponent(run.botId)}?m=${encodeURIComponent(run.messageId)}`
      : null;
  const line = (
    <>
      <time dateTime={at} title={new Date(at).toLocaleString(locale)} className="text-foreground">
        {formatRoutineRunAt(run, locale)}
      </time>
      {lateLabel ? <span>{lateLabel}</span> : null}
      {run.status !== "completed" ? (
        <span className={`ml-auto ${statusTone(run.status)}`}>{statusLabel(run.status)}</span>
      ) : chatTo || reply ? null : (
        <span className="ml-auto">{t`No reply`}</span>
      )}
      {chatTo || reply ? (
        <ChevronRight
          aria-hidden
          className={`size-4 shrink-0 transition-transform duration-150 group-data-panel-open/run:rotate-90 motion-reduce:transition-none ${run.status === "completed" ? "ml-auto" : ""}`}
        />
      ) : null}
    </>
  );
  const lineClass = "-mx-2 flex items-center gap-3 rounded-md px-2 py-2";
  return (
    <li data-testid="routine-run-row" className="text-body-sm">
      {reply ? (
        <Collapsible>
          <CollapsibleTrigger
            className={`group/run ${lineClass} box-content w-full cursor-pointer text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring`}
          >
            {line}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <RunReply blocks={reply} />
          </CollapsibleContent>
        </Collapsible>
      ) : chatTo ? (
        <Link to={chatTo} className={`${lineClass} hover:bg-accent`}>
          {line}
        </Link>
      ) : (
        <div className={lineClass}>{line}</div>
      )}
      {run.status === "failed" && run.error ? (
        <div className="-mt-1 pb-2 text-destructive">
          <p>{normalizeRunError(run.error, translateRunError, locale).summary}</p>
          <details key={run.error} className="mt-1">
            <summary className="w-fit cursor-pointer">{t`Details`}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-label">{run.error}</pre>
          </details>
        </div>
      ) : null}
    </li>
  );
}

/** What a silent run would have posted: its steps and its reply, as the chat shows them. */
function RunReply({ blocks }: { blocks: readonly MessageBlock[] }) {
  return (
    <div
      data-testid="routine-run-reply"
      className="space-y-2 pt-1 pb-3 text-body text-foreground"
      dir="auto"
    >
      {blocks.map((block, index) =>
        block.kind === "steps" ? (
          <ToolActivityDisclosure
            key={index}
            live={false}
            stepCount={toolStepCount(block.steps)}
            durationMs={block.durationMs}
          >
            <ToolSteps steps={block.steps} />
          </ToolActivityDisclosure>
        ) : block.kind === "text" ? (
          <ChatMarkdown key={index}>{block.text}</ChatMarkdown>
        ) : null,
      )}
    </div>
  );
}
