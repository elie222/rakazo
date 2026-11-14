import { Trans, useLingui } from "@lingui/react/macro";
import type { AuditEvent } from "@rakazo/contracts";
import { Button, buttonVariants, SectionHeading } from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import { queryClient } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorCode, errorText } from "../lib/user-error";

const PAGE_SIZE = 50;

function connectionIds(event: AuditEvent): string {
  return [event.metadata.connectorId, event.metadata.connectionId]
    .filter((id): id is string => typeof id === "string")
    .join(" · ");
}

/** The organization's audit log, newest first. Shown only to those the server lets read it. */
export function AuditLog({ organizationId }: { organizationId: string }) {
  const { t } = useLingui();
  const log = useInfiniteQuery(
    {
      queryKey: ["audit-log", organizationId],
      queryFn: ({ pageParam }) =>
        rpc.audit.events({ limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
    },
    queryClient,
  );
  if (log.isPending || errorCode(log.error) === "FORBIDDEN") return null;
  const events = log.data?.pages.flatMap((page) => page.events) ?? [];
  const nextCursor = log.data?.pages.at(-1)?.nextCursor ?? null;
  return (
    <section data-testid="audit-log" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <SectionHeading>
          <Trans>Log</Trans>
        </SectionHeading>
        <a
          href="/api/audit-events/export"
          download
          className={buttonVariants({ variant: "outline" })}
        >
          <Trans>Export</Trans>
        </a>
      </div>
      {log.isError ? (
        <p role="alert" className="text-body-sm text-destructive">
          {errorText(log.error, t`Could not load the log.`)}
        </p>
      ) : null}
      {events.length > 0 ? (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {events.map((event) => (
            <li key={event.id} className="px-4 py-3 text-body">
              <div className="flex flex-wrap justify-between gap-x-4">
                <span className="min-w-0 break-words">
                  {event.actorLabel ?? event.actorType} · {event.action}
                </span>
                {event.outcome === "success" ? null : (
                  <span className="text-muted-foreground">{event.outcome}</span>
                )}
              </div>
              <div className="flex flex-wrap justify-between gap-x-4 text-body-sm text-muted-foreground">
                <span className="min-w-0 break-words">
                  {[event.targetLabel, connectionIds(event)].filter(Boolean).join(" · ")}
                </span>
                <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {nextCursor ? (
        <Button
          variant="outline"
          disabled={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          <Trans>Load more</Trans>
        </Button>
      ) : null}
    </section>
  );
}
