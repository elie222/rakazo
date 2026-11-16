import { Trans, useLingui } from "@lingui/react/macro";
import type { AuditEvent } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { downloadArtifactBytes } from "../lib/artifact-open";
import { queryClient } from "../lib/query";
import { rpc, withSpaceHeaders } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SettingsPageHeader } from "./SettingsPageHeader";

const PAGE_SIZE = 50;

function detailLabels(event: AuditEvent): string[] {
  return [event.targetLabel, event.metadata.connectorId, event.metadata.connectionId].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

/** A plain link cannot send the selected Space, so the export could come from another organization. */
async function downloadExport(): Promise<void> {
  const response = await fetch("/api/audit-events/export", {
    headers: withSpaceHeaders(),
    credentials: "include",
  });
  if (!response.ok) throw new Error(`Export failed (${response.status})`);
  const name =
    /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ??
    "rakazo-audit-log.jsonl";
  downloadArtifactBytes(name, "application/x-ndjson", new Uint8Array(await response.arrayBuffer()));
}

/**
 * The organization's activity log, newest first, on its own page. The server decides whose events
 * it holds: everyone's for owners and admins, the reader's own for other members.
 */
export function AuditLog({
  organizationId,
  onBack,
}: {
  organizationId: string;
  onBack: () => void;
}) {
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
  const download = useMutation({ mutationFn: downloadExport }, queryClient);
  const events = log.data?.pages.flatMap((page) => page.events) ?? [];
  const nextCursor = log.data?.pages.at(-1)?.nextCursor ?? null;
  return (
    <section data-testid="audit-log" className="space-y-4">
      <SettingsPageHeader
        title={t`Activity log`}
        onBack={onBack}
        trailing={
          <Button variant="outline" disabled={download.isPending} onClick={() => download.mutate()}>
            <Trans>Export</Trans>
          </Button>
        }
      />
      {log.isError ? (
        <p role="alert" className="text-body-sm text-destructive">
          {errorText(log.error, t`Could not load the log.`)}
        </p>
      ) : null}
      {download.isError ? (
        <p role="alert" className="text-body-sm text-destructive">
          {errorText(download.error, t`Could not export the log.`)}
        </p>
      ) : null}
      {events.length > 0 ? (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {events.map((event) => (
            <li key={event.id} className="px-4 py-3 text-body">
              <div className="flex flex-wrap justify-between gap-x-4">
                <span className="min-w-0 break-words">{event.action}</span>
                {event.outcome === "success" ? null : (
                  <span className="text-muted-foreground">{event.outcome}</span>
                )}
              </div>
              <div className="flex flex-wrap justify-between gap-x-4 text-body-sm text-muted-foreground">
                <span className="flex min-w-0 flex-wrap gap-x-3 break-words">
                  <span>{event.actorLabel ?? event.actorType}</span>
                  {detailLabels(event).map((label) => (
                    <span key={label}>{label}</span>
                  ))}
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
