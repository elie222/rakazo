import { Trans, useLingui } from "@lingui/react/macro";
import type { BotWorkLogEntry } from "@rakazo/contracts";
import { workLogRow } from "@rakazo/core";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../lib/query";
import { formatRelativeTime } from "../lib/relative-time";

function WorkLogRow({ entry }: { entry: BotWorkLogEntry }) {
  const { t } = useLingui();
  const { action } = entry;
  const { title, size, exitCode } = workLogRow(entry);
  const summary = (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate font-mono text-body-sm text-foreground" dir="auto">
        {title}
      </span>
      <span className="flex flex-wrap gap-x-2 text-label text-muted-foreground">
        {title !== entry.tool ? <span>{entry.tool}</span> : null}
        {size ? <span>{size}</span> : null}
        {exitCode ? <span className="text-destructive">{t`Exit code ${exitCode}`}</span> : null}
        <span>{formatRelativeTime(entry.createdAt)}</span>
      </span>
    </span>
  );
  if (!action?.output) return <li className="px-2 py-2">{summary}</li>;
  return (
    <li>
      <Collapsible>
        <CollapsibleTrigger className="flex w-full items-center rounded-md px-2 py-2 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          {summary}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mx-2 mb-2 max-h-60 overflow-auto rounded-md bg-muted p-2 font-mono text-label whitespace-pre-wrap text-foreground">
            {action.output}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/** What a bot did lately across its runs, newest first: the tools it called and what they did on its computer. */
export function BotWorkLog({ botId }: { botId: string }) {
  const queries = useSpaceQueries();
  const log = useQuery(
    queries.bots.workLog.queryOptions({ input: { botId }, refetchOnWindowFocus: "always" }),
  );
  if (log.isPending) {
    return (
      <div className="grid place-items-center py-6 text-muted-foreground">
        <Spinner />
      </div>
    );
  }
  if (log.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 px-1 py-2">
        <p className="text-body-sm text-muted-foreground">
          <Trans>Couldn't load logs.</Trans>
        </p>
        <Button size="sm" variant="outline" onClick={() => void log.refetch()}>
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  }
  if (log.data.length === 0) {
    return (
      <p className="px-1 py-2 text-body-sm text-muted-foreground">
        <Trans>No activity yet.</Trans>
      </p>
    );
  }
  return (
    <ul className="space-y-0.5">
      {log.data.map((entry) => (
        <WorkLogRow key={entry.id} entry={entry} />
      ))}
    </ul>
  );
}
