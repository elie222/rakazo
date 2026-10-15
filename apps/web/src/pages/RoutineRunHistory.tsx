import { Trans, useLingui } from "@lingui/react/macro";
import type { RoutineHistory } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { RunExecutionProfileDetails } from "../components/RunExecutionProfileDetails";
import { rpc } from "../lib/rpc";
import { formatToolActivityDuration } from "../lib/tool-activity-view";
import { statusLabel, statusTone } from "./ActivityList";

export function RoutineRunHistory({ routineId }: { routineId: string }) {
  const { i18n } = useLingui();
  const [history, setHistory] = useState<RoutineHistory | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const firstPageRequest = useRef(0);
  const acceptedFirstPage = useRef(0);
  const expandedRef = useRef(false);
  const hasLoadedOlder = useRef(false);
  const listId = useId();
  const runs = history?.runs ?? null;

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    generation.current += 1;
    setHistory(null);
    setFailed(false);
    setLoadingMore(false);
    hasLoadedOlder.current = false;

    async function loadFirstPage() {
      try {
        const page = await rpc.routines.history({ routineId });
        if (cancelled) return;
        hasLoadedOlder.current = false;
        setHistory(page);
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }

    async function poll() {
      // Expanded browsing uses explicit Refresh only so loaded older pages stay coherent.
      if (expandedRef.current) {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 15_000);
        return;
      }
      const request = generation.current;
      const sequence = ++firstPageRequest.current;
      try {
        const page = await rpc.routines.history({ routineId });
        if (
          cancelled ||
          request !== generation.current ||
          expandedRef.current ||
          sequence < acceptedFirstPage.current
        )
          return;
        acceptedFirstPage.current = sequence;
        hasLoadedOlder.current = false;
        setHistory(page);
        setFailed(false);
      } catch {
        if (
          !cancelled &&
          request === generation.current &&
          !expandedRef.current &&
          sequence >= acceptedFirstPage.current
        )
          setFailed(true);
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 15_000);
      }
    }

    void loadFirstPage().then(() => {
      if (!cancelled) timer = window.setTimeout(() => void poll(), 15_000);
    });
    return () => {
      cancelled = true;
      generation.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [routineId, revision]);

  function toggleExpanded() {
    const next = !expanded;
    expandedRef.current = next;
    generation.current += 1;
    setLoadingMore(false);
    setExpanded(next);
    if (next || !hasLoadedOlder.current) return;
    const request = generation.current;
    const sequence = ++firstPageRequest.current;
    void rpc.routines
      .history({ routineId })
      .then((page) => {
        if (
          request !== generation.current ||
          expandedRef.current ||
          sequence < acceptedFirstPage.current
        )
          return;
        acceptedFirstPage.current = sequence;
        hasLoadedOlder.current = false;
        setHistory(page);
        setFailed(false);
      })
      .catch(() => {
        if (
          request === generation.current &&
          !expandedRef.current &&
          sequence >= acceptedFirstPage.current
        )
          setFailed(true);
      });
  }

  async function loadMore() {
    if (!history?.nextCursor || loadingMore) return;
    const request = generation.current;
    setLoadingMore(true);
    try {
      const page = await rpc.routines.history({ routineId, before: history.nextCursor });
      if (request !== generation.current) return;
      hasLoadedOlder.current = true;
      setHistory((current) =>
        current
          ? {
              runs: [
                ...current.runs,
                ...page.runs.filter(
                  (run) => !current.runs.some((existing) => existing.id === run.id),
                ),
              ],
              nextCursor: page.nextCursor,
            }
          : current,
      );
      setFailed(false);
    } catch {
      if (request === generation.current) setFailed(true);
    } finally {
      if (request === generation.current) setLoadingMore(false);
    }
  }

  return (
    <section data-testid="routine-run-history" className="mt-8 text-sm text-muted-foreground">
      <div className="flex items-center justify-between gap-2">
        <h3>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={toggleExpanded}
            className="flex items-center gap-2 hover:text-foreground"
          >
            <Trans>Run history</Trans>
            <ChevronDown size={14} aria-hidden className={expanded ? "rotate-180" : undefined} />
          </button>
        </h3>
        {expanded ? (
          <Button size="xs" variant="ghost" onClick={() => setRevision((value) => value + 1)}>
            <Trans>Refresh</Trans>
          </Button>
        ) : null}
      </div>
      {failed ? (
        <p role="alert" className="mt-2 text-[13.5px] text-destructive">
          <Trans>Could not load run history</Trans>
        </p>
      ) : runs === null ? (
        <p role="status" className="mt-2 text-[13.5px]">
          <Trans>Loading…</Trans>
        </p>
      ) : runs.length === 0 ? (
        <p className="mt-2 text-[13.5px]">
          <Trans>No runs yet</Trans>
        </p>
      ) : null}
      {runs && runs.length > 0 ? (
        <ul id={listId} className="mt-2 divide-y divide-border">
          {(expanded ? runs : runs.slice(0, 1)).map((run) => {
            const at = run.startedAt ?? run.createdAt;
            const duration =
              run.startedAt && run.completedAt
                ? formatToolActivityDuration(
                    Date.parse(run.completedAt) - Date.parse(run.startedAt),
                  )
                : null;
            const chatTo = run.messageId
              ? run.groupId
                ? `/app/g/${encodeURIComponent(run.groupId)}?m=${encodeURIComponent(run.messageId)}`
                : `/app/${encodeURIComponent(run.botId)}?m=${encodeURIComponent(run.messageId)}`
              : null;
            return (
              <li key={run.id} className="py-2.5 text-[13px]" data-testid="routine-run-row">
                <div className="flex items-center justify-between gap-2">
                  <time dateTime={at} title={new Date(at).toLocaleString(i18n.locale || "en")}>
                    {new Date(at).toLocaleString(i18n.locale || "en", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                  <span className={statusTone(run.status)}>{statusLabel(run.status)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span>{duration}</span>
                  {expanded ? <RunExecutionProfileDetails profile={run.executionProfile} /> : null}
                  {chatTo ? (
                    <Link to={chatTo} className="text-foreground underline underline-offset-2">
                      <Trans>View chat</Trans>
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {expanded && history?.nextCursor ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={loadingMore}
          onClick={() => void loadMore()}
          className="mt-2"
        >
          <Trans>Load older runs</Trans>
        </Button>
      ) : null}
    </section>
  );
}
