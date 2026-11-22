import { Trans, useLingui } from "@lingui/react/macro";
import type { AuditEvent } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { downloadArtifactBytes } from "../../lib/pages/artifact-open";
import { queryClient } from "../../lib/query/query";
import { recheckSessionOnUnauthorized, rpc, withSpaceHeaders } from "../../lib/query/rpc";
import { errorCode, errorText } from "../../lib/query/user-error";
import { SettingsPageHeader } from "../settings/SettingsPageHeader";

const PAGE_SIZE = 50;

/** Metadata keys that name what changed or what was decided. */
const IDENTIFYING_KEYS = [
  "connectorId",
  "connectionId",
  "provider",
  "serverId",
  "id",
  "botId",
  "name",
  "decision",
];

function detailLabels(event: AuditEvent): string[] {
  const target = [event.targetLabel, event.targetId, event.targetType].find(Boolean);
  const labels = [target, ...IDENTIFYING_KEYS.map((key) => event.metadata[key])].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return [...new Set(labels)];
}

/**
 * A plain link cannot send a Space, so the export is fetched with the header of the organization's
 * own Space. The Space selected in the sidebar can belong to another organization.
 */
async function downloadExport(spaceId: string): Promise<void> {
  const response = await fetch("/api/audit-events/export", {
    headers: withSpaceHeaders(undefined, spaceId),
    credentials: "include",
  });
  if (!response.ok) {
    recheckSessionOnUnauthorized(response.status);
    throw new Error(`Export failed (${response.status})`);
  }
  const name =
    /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ??
    "rakazo-audit-log.jsonl";
  downloadArtifactBytes(name, "application/x-ndjson", new Uint8Array(await response.arrayBuffer()));
}

/**
 * The organization's activity log, newest first, on its own page. The server decides whose events
 * it holds: everyone's for owners and admins, the reader's own for other members. `spaceId` is a
 * Space of that organization, which is how the server finds it.
 */
export function AuditLog({
  organizationId,
  spaceId,
  onBack,
}: {
  organizationId: string;
  spaceId: string;
  onBack: () => void;
}) {
  const { t, i18n } = useLingui();
  const log = useInfiniteQuery(
    {
      queryKey: ["audit-log", organizationId, spaceId],
      queryFn: ({ pageParam }) =>
        rpc.audit.events(
          { limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
          { context: { spaceId } },
        ),
      // Events are not kept once the page closes, and a window coming back to focus asks again,
      // so a reader whose access was removed meanwhile stops seeing them.
      gcTime: 0,
      refetchOnWindowFocus: "always",
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
    },
    queryClient,
  );
  const download = useMutation(
    {
      mutationFn: () => downloadExport(spaceId),
      // A refused export may mean access was removed: reading the log again sends that reader back.
      onError: () => void log.refetch(),
    },
    queryClient,
  );
  // Not allowed, or no longer a member of the Space the log is read through.
  const code = errorCode(log.error);
  const refused = code === "FORBIDDEN" || code === "UNAUTHORIZED";
  // A reader the server no longer lets in, on the first read or on a later page, sees no log.
  useEffect(() => {
    if (refused) onBack();
  }, [refused, onBack]);
  const events = refused ? [] : (log.data?.pages.flatMap((page) => page.events) ?? []);
  const nextCursor = refused ? null : (log.data?.pages.at(-1)?.nextCursor ?? null);
  return (
    <section data-testid="audit-log" className="space-y-4">
      <SettingsPageHeader
        title={t`Activity log`}
        onBack={onBack}
        trailing={
          <Button
            variant="outline"
            disabled={download.isPending || !log.data || log.isError || refused}
            onClick={() => download.mutate()}
          >
            <Trans>Export</Trans>
          </Button>
        }
      />
      {log.isError && !refused ? (
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
                  <span>{[event.actorLabel, event.actorId, event.actorType].find(Boolean)}</span>
                  {detailLabels(event).map((label) => (
                    <span key={label}>{label}</span>
                  ))}
                </span>
                <time dateTime={event.createdAt}>
                  {new Date(event.createdAt).toLocaleString(i18n.locale)}
                </time>
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
