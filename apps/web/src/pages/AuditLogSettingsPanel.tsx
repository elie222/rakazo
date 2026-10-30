import { Trans, useLingui } from "@lingui/react/macro";
import type { AuditEvent } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@rakazo/ui-web/components/ui/table";
import { useEffect, useState } from "react";
import { rpc, withSpaceHeaders } from "../lib/rpc";

export function AuditLogSettingsPanel() {
  const { t, i18n } = useLingui();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const time = new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium", timeStyle: "short" });

  useEffect(() => {
    let active = true;
    rpc.audit
      .events({ limit: 100 })
      .then((page) => {
        if (!active) return;
        setEvents(page.events);
        setNextCursor(page.nextCursor);
      })
      .catch(() => {
        if (active) setError(t`Could not load the audit log`);
      });
    return () => {
      active = false;
    };
  }, [t]);

  async function loadMore(cursor: string) {
    setPending(true);
    setError(null);
    try {
      const page = await rpc.audit.events({ cursor, limit: 100 });
      setEvents((previous) => [...(previous ?? []), ...page.events]);
      setNextCursor(page.nextCursor);
    } catch {
      setError(t`Could not load the audit log`);
    } finally {
      setPending(false);
    }
  }

  async function exportLog() {
    setError(null);
    try {
      const response = await fetch("/api/audit-events/export", {
        headers: withSpaceHeaders(),
        credentials: "include",
      });
      if (!response.ok) throw new Error(String(response.status));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `rakazo-audit-log-${new Date().toISOString().slice(0, 10)}.jsonl`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(t`Could not export the audit log`);
    }
  }

  return (
    <div data-testid="audit-log-settings">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => void exportLog()}>
          <Trans>Export</Trans>
        </Button>
      </div>
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
      {events?.length ? (
        <div className="mt-3 rounded-xl border border-border px-2">
          <Table className="text-[13.5px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-muted-foreground">
                  <Trans>Time</Trans>
                </TableHead>
                <TableHead className="text-muted-foreground">
                  <Trans>Actor</Trans>
                </TableHead>
                <TableHead className="text-muted-foreground">
                  <Trans>Action</Trans>
                </TableHead>
                <TableHead className="text-muted-foreground">
                  <Trans>Target</Trans>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id} className="hover:bg-transparent">
                  <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                    {time.format(new Date(event.createdAt))}
                  </TableCell>
                  <TableCell className="text-foreground">
                    {event.actorLabel ?? event.actorType}
                  </TableCell>
                  <TableCell>
                    <div className="font-mono text-[12.5px] text-foreground">{event.action}</div>
                    {event.outcome === "success" ? null : (
                      <div className="text-[12px] text-destructive">
                        {event.outcome === "denied" ? t`Denied` : t`Failed`}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="text-foreground">{event.targetLabel ?? event.targetType}</div>
                    {event.spaceName ? (
                      <div className="text-[12px] text-muted-foreground">{event.spaceName}</div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : events ? (
        <p className="mt-3 text-[13px] text-muted-foreground">
          <Trans>No events yet</Trans>
        </p>
      ) : null}
      {nextCursor ? (
        <div className="mt-3 flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => void loadMore(nextCursor)}
          >
            <Trans>Load more</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
