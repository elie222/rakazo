import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type {
  Board,
  Bot,
  BotTicketIssue,
  Ticket,
  TicketComment,
  TicketEvent,
  TicketPriority,
  TicketStatus,
} from "@rakazo/contracts";
import {
  checkTicketTransition,
  TICKET_DESCRIPTION_MAX_LENGTH,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TITLE_MAX_LENGTH,
  TICKET_WIP_LIMIT,
} from "@rakazo/contracts";
import {
  Badge,
  BotAvatar,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  NativeSelect,
  NativeSelectOption,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@rakazo/ui-web";
import {
  AlertTriangle,
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { desktopBridge } from "../lib/desktop";
import { formatRelativeTime } from "../lib/relative-time";
import { rpc } from "../lib/rpc";
import { useTicketPriorityLabels } from "../lib/ticket-priority";
import { useTicketStatusLabels } from "../lib/ticket-status";
import { WindowChrome } from "./WindowChrome";

type CollapsibleStatus = "done" | "closed";
const COLLAPSIBLE_STATUSES: readonly CollapsibleStatus[] = ["done", "closed"];
const COLLAPSED_STORAGE_KEYS: Record<CollapsibleStatus, string> = {
  closed: "rakazo:board-closed-collapsed",
  done: "rakazo:board-done-collapsed",
};

function isCollapsible(status: TicketStatus): status is CollapsibleStatus {
  return (COLLAPSIBLE_STATUSES as readonly string[]).includes(status);
}

/** Finished columns start collapsed; opening one is remembered per column. */
function readCollapsed(): Record<CollapsibleStatus, boolean> {
  const read = (status: CollapsibleStatus) => {
    try {
      return window.localStorage.getItem(COLLAPSED_STORAGE_KEYS[status]) !== "open";
    } catch {
      return true;
    }
  };
  return { done: read("done"), closed: read("closed") };
}

function writeCollapsed(status: CollapsibleStatus, collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEYS[status], collapsed ? "collapsed" : "open");
  } catch {
    // Preference only; ignore storage failures.
  }
}

const AGING_DAYS: Partial<Record<TicketStatus, number>> = { doing: 3, review: 2, blocked: 3 };

function daysSince(iso: string, now = Date.now()): number {
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? 0 : Math.floor((now - time) / 86_400_000);
}

/**
 * The board screen: one column per status, live reload on board events, a create
 * dialog, and a ticket detail with the description and comments.
 */
export function BoardPage() {
  const { t } = useLingui();
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [workingTicketIds, setWorkingTicketIds] = useState<ReadonlySet<string>>(new Set());
  const [botIssues, setBotIssues] = useState<BotTicketIssue[]>([]);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [boardVersion, setBoardVersion] = useState(0);
  const generation = useRef(0);
  const boardsGeneration = useRef(0);

  const activeBoardId = selectedBoardId ?? boards?.[0]?.id ?? null;
  const board = boards?.find((item) => item.id === activeBoardId) ?? null;

  const loadTickets = useCallback(
    async (boardId: string) => {
      const current = ++generation.current;
      try {
        const next = await rpc.tickets.list({ boardId });
        if (current !== generation.current) return;
        setTickets(next.tickets);
        setWorkingTicketIds(new Set(next.workingTicketIds));
        setBotIssues(next.botIssues);
        setLoadError(null);
      } catch (error) {
        if (current !== generation.current) return;
        setLoadError(error instanceof Error ? error.message : t`Could not load the board.`);
      }
    },
    [t],
  );

  useEffect(() => {
    const current = ++boardsGeneration.current;
    void (async () => {
      try {
        const next = await rpc.boards.list();
        if (current !== boardsGeneration.current) return;
        setBoards(next);
        setSelectedBoardId((previous) => previous ?? next[0]?.id ?? null);
        setLoadError(null);
      } catch (error) {
        if (current !== boardsGeneration.current) return;
        setLoadError(error instanceof Error ? error.message : t`Could not load the board.`);
      }
    })();
  }, [t]);

  useEffect(() => {
    setTickets(null);
    if (activeBoardId) void loadTickets(activeBoardId);
  }, [activeBoardId, loadTickets]);

  useEffect(() => {
    void rpc.bots.list().then(setBots);
  }, []);

  const reload = useCallback(() => {
    if (activeBoardId) void loadTickets(activeBoardId);
    setBoardVersion((version) => version + 1);
  }, [activeBoardId, loadTickets]);

  // Live board updates: refetch on any push, on the server heartbeat (a periodic
  // catch-up), and when the tab becomes visible again after being hidden.
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    // Skip refetches while hidden; the visible transition does one catch-up load.
    const refresh = () => {
      if (disposed || !activeBoardId || document.visibilityState === "hidden") return;
      void loadTickets(activeBoardId);
      const boardsLoad = ++boardsGeneration.current;
      void rpc.boards
        .list()
        .then((next) => {
          if (disposed || boardsLoad !== boardsGeneration.current) return;
          setBoards(next);
        })
        .catch(() => undefined);
      // Bump the token so the open detail reloads its comments too.
      setBoardVersion((version) => version + 1);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    void (async () => {
      while (!disposed) {
        try {
          const events = await rpc.boards.subscribe(undefined, { signal: controller.signal });
          for await (const _event of events) {
            if (disposed) break;
            refresh();
          }
        } catch {
          // The stream ended or aborted; retry while the page is still mounted.
        }
        if (disposed) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    })();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      controller.abort();
    };
  }, [activeBoardId, loadTickets]);

  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const boardItems = useMemo(
    () => (boards ?? []).map((item) => ({ value: item.id, label: item.name })),
    [boards],
  );
  const selected = tickets?.find((ticket) => ticket.id === selectedId) ?? null;

  const toggleCollapsed = useCallback((status: CollapsibleStatus) => {
    setCollapsed((previous) => {
      const next = !previous[status];
      writeCollapsed(status, next);
      return { ...previous, [status]: next };
    });
  }, []);

  const issuesByBot = useMemo(
    () => new Map(botIssues.map((issue) => [issue.botId, issue])),
    [botIssues],
  );

  const performMove = useCallback(
    async (id: string, status: TicketStatus, reason?: string): Promise<boolean> => {
      setMoveError(null);
      try {
        await rpc.tickets.update({ id, status, ...(reason ? { reason } : {}) });
        return true;
      } catch (error) {
        setMoveError(error instanceof Error ? error.message : t`Could not move the ticket.`);
        return false;
      } finally {
        reload();
      }
    },
    [reload, t],
  );

  // Apply the board rules before calling the server: a move that only needs a
  // justification opens a reason dialog, anything else fails with the rule's message.
  const requestMove = useCallback(
    async (ticket: Ticket, status: TicketStatus) => {
      const base = {
        from: ticket.status,
        to: status,
        criteria: ticket.acceptanceCriteria,
        hasAssignee: ticket.assigneeBotId !== null,
      };
      const message = checkTicketTransition(base);
      if (!message) {
        await performMove(ticket.id, status);
      } else if (checkTicketTransition({ ...base, reason: "x" }) === null) {
        setMoveError(null);
        setPendingMove({ ticket, status, message });
      } else {
        setMoveError(message);
      }
    },
    [performMove],
  );

  return (
    <div className="flex h-full min-w-0 flex-col bg-background text-foreground/90">
      <header className="app-drag border-b border-border px-4 py-4 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
            {desktopBridge() ? <WindowChrome /> : null}
            <Link
              to="/app"
              className="app-no-drag flex shrink-0 items-center gap-0.5 rounded-lg py-1 pe-1.5 text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <ChevronLeft size={16} strokeWidth={1.9} aria-hidden="true" />
              <Trans>Bots</Trans>
            </Link>
            <h1 className="text-xl font-semibold">
              <Trans>Boards</Trans>
            </h1>
            {activeBoardId ? (
              <Select
                value={activeBoardId}
                onValueChange={(value) => {
                  if (typeof value === "string" && value) setSelectedBoardId(value);
                }}
                items={boardItems}
              >
                <SelectTrigger aria-label={t`Board`} className="app-no-drag ms-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(boards ?? []).map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
          <Button
            className="app-no-drag rounded-full"
            onClick={() => setCreateOpen(true)}
            disabled={board === null || bots.length === 0}
          >
            <Plus size={15} strokeWidth={1.9} />
            <Trans>New ticket</Trans>
          </Button>
        </div>
      </header>

      {moveError ? (
        <div role="alert" className="px-6 py-2 text-sm text-destructive">
          {moveError}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {loadError ? (
          <div className="grid h-full place-items-center px-6 text-sm text-destructive">
            {loadError}
          </div>
        ) : tickets === null ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground/80">
            <Trans>Loading…</Trans>
          </div>
        ) : (
          <BoardColumns
            tickets={tickets}
            botsById={botsById}
            workingTicketIds={workingTicketIds}
            issuesByBot={issuesByBot}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            onOpen={(id) => setSelectedId(id)}
            onMove={(ticket, status) => void requestMove(ticket, status)}
          />
        )}
      </div>

      <NewTicketDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        bots={bots}
        boardId={activeBoardId}
        onCreated={reload}
      />

      <ReasonDialog
        pending={pendingMove}
        onCancel={() => setPendingMove(null)}
        onConfirm={async (reason) => {
          if (!pendingMove) return;
          const moved = await performMove(pendingMove.ticket.id, pendingMove.status, reason);
          if (moved) setPendingMove(null);
        }}
      />

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <DialogContent className="flex max-h-[85vh] w-[calc(100%-1rem)] max-w-5xl flex-col gap-0 overflow-hidden sm:max-w-5xl">
          {selected ? (
            <TicketDetail
              ticket={selected}
              bots={bots}
              working={workingTicketIds.has(selected.id)}
              onRequestMove={(status) => void requestMove(selected, status)}
              onChanged={reload}
              refreshToken={boardVersion}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

type PendingMove = { ticket: Ticket; status: TicketStatus; message: string };

function BoardColumns({
  tickets,
  botsById,
  workingTicketIds,
  issuesByBot,
  collapsed: collapsedByStatus,
  onToggleCollapsed,
  onOpen,
  onMove,
}: {
  tickets: Ticket[];
  botsById: Map<string, Bot>;
  workingTicketIds: ReadonlySet<string>;
  issuesByBot: ReadonlyMap<string, BotTicketIssue>;
  collapsed: Record<CollapsibleStatus, boolean>;
  onToggleCollapsed: (status: CollapsibleStatus) => void;
  onOpen: (id: string) => void;
  onMove: (ticket: Ticket, status: TicketStatus) => void;
}) {
  // Bots over the in-progress limit get a warning on their cards, not a hard block.
  const doingByBot = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ticket of tickets) {
      if (ticket.status === "doing" && ticket.assigneeBotId) {
        counts.set(ticket.assigneeBotId, (counts.get(ticket.assigneeBotId) ?? 0) + 1);
      }
    }
    return counts;
  }, [tickets]);
  const columns = useMemo(
    () =>
      TICKET_STATUSES.map((status) => ({
        status,
        tickets: tickets.filter((t) => t.status === status),
      })),
    [tickets],
  );
  return (
    <div
      data-testid="board-columns"
      className="flex h-full gap-4 overflow-x-auto px-4 py-4 md:px-6"
    >
      {columns.map((column) => {
        const collapsed = isCollapsible(column.status) && collapsedByStatus[column.status];
        return (
          <BoardColumn
            key={column.status}
            status={column.status}
            tickets={column.tickets}
            collapsed={collapsed}
            onToggle={
              isCollapsible(column.status)
                ? () => onToggleCollapsed(column.status as CollapsibleStatus)
                : undefined
            }
            botsById={botsById}
            workingTicketIds={workingTicketIds}
            issuesByBot={issuesByBot}
            doingByBot={doingByBot}
            onOpen={onOpen}
            onMove={onMove}
          />
        );
      })}
    </div>
  );
}

function BoardColumn({
  status,
  tickets,
  collapsed,
  onToggle,
  botsById,
  workingTicketIds,
  issuesByBot,
  doingByBot,
  onOpen,
  onMove,
}: {
  status: TicketStatus;
  tickets: Ticket[];
  collapsed: boolean;
  onToggle?: () => void;
  botsById: Map<string, Bot>;
  workingTicketIds: ReadonlySet<string>;
  issuesByBot: ReadonlyMap<string, BotTicketIssue>;
  doingByBot: ReadonlyMap<string, number>;
  onOpen: (id: string) => void;
  onMove: (ticket: Ticket, status: TicketStatus) => void;
}) {
  const labels = useTicketStatusLabels();
  if (collapsed) {
    return (
      <button
        type="button"
        data-testid={`board-column-${status}`}
        data-collapsed="true"
        aria-expanded={false}
        aria-label={labels[status]}
        onClick={onToggle}
        className="flex w-10 shrink-0 flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-card/40 py-3 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        <span
          className="text-[12px] font-semibold text-foreground/90"
          style={{ writingMode: "vertical-rl" }}
        >
          {labels[status]}
        </span>
        <span className="text-[12px] tabular-nums text-muted-foreground">{tickets.length}</span>
      </button>
    );
  }
  return (
    <section
      data-testid={`board-column-${status}`}
      className="flex w-[280px] shrink-0 flex-col overflow-hidden rounded-2xl border border-border bg-card/40"
    >
      <header className="flex items-center justify-between gap-2 px-3 py-2.5">
        <span className="text-[13px] font-semibold text-foreground/90">{labels[status]}</span>
        <div className="flex items-center gap-1">
          <span className="text-[12px] tabular-nums text-muted-foreground">{tickets.length}</span>
          {onToggle ? (
            <button
              type="button"
              aria-expanded={true}
              aria-label={labels[status]}
              onClick={onToggle}
              className="grid h-5 w-5 place-items-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronRight size={13} strokeWidth={1.9} />
            </button>
          ) : null}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {tickets.map((ticket) => (
          <BoardCard
            key={ticket.id}
            ticket={ticket}
            assignee={ticket.assigneeBotId ? botsById.get(ticket.assigneeBotId) : undefined}
            working={workingTicketIds.has(ticket.id)}
            issue={
              ticket.assigneeBotId && isActionableStatus(ticket.status)
                ? issuesByBot.get(ticket.assigneeBotId)
                : undefined
            }
            overLimit={
              ticket.status === "doing" && ticket.assigneeBotId
                ? (doingByBot.get(ticket.assigneeBotId) ?? 0) > TICKET_WIP_LIMIT
                : false
            }
            onOpen={onOpen}
            onMove={onMove}
          />
        ))}
      </div>
    </section>
  );
}

function BoardCard({
  ticket,
  assignee,
  working,
  issue,
  overLimit,
  onOpen,
  onMove,
}: {
  ticket: Ticket;
  assignee: Bot | undefined;
  working: boolean;
  issue: BotTicketIssue | undefined;
  overLimit: boolean;
  onOpen: (id: string) => void;
  onMove: (ticket: Ticket, status: TicketStatus) => void;
}) {
  const { t } = useLingui();
  const labels = useTicketStatusLabels();
  const priorityLabels = useTicketPriorityLabels();
  const showPriority = ticket.priority === "high" || ticket.priority === "urgent";
  const criteriaDone = ticket.acceptanceCriteria.filter((item) => item.done).length;
  const criteriaTotal = ticket.acceptanceCriteria.length;
  const agingLimit = AGING_DAYS[ticket.status];
  const columnDays = daysSince(ticket.statusChangedAt);
  const aging = agingLimit !== undefined && columnDays >= agingLimit;
  return (
    <div className="group relative">
      <button
        type="button"
        data-testid={`board-card-${ticket.id}`}
        onClick={() => onOpen(ticket.id)}
        className="flex w-full flex-col gap-1.5 rounded-xl border border-border bg-card p-3 pe-9 text-start transition-colors hover:bg-accent/40"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">{ticket.ref}</span>
          {showPriority ? (
            <Badge
              variant={ticket.priority === "urgent" ? "destructive" : "outline"}
              className={
                ticket.priority === "urgent"
                  ? "h-4 px-1.5 text-[10.5px]"
                  : "h-4 border-warning/40 px-1.5 text-[10.5px] text-warning"
              }
            >
              {priorityLabels[ticket.priority]}
            </Badge>
          ) : null}
          {criteriaTotal > 0 ? (
            <span
              data-testid="ticket-criteria-progress"
              title={t`Acceptance criteria`}
              className={`inline-flex items-center gap-1 text-[11px] tabular-nums ${
                criteriaDone === criteriaTotal ? "text-success" : "text-muted-foreground"
              }`}
            >
              <CheckSquare size={11} strokeWidth={1.9} aria-hidden="true" />
              {criteriaDone}/{criteriaTotal}
            </span>
          ) : null}
          {aging ? (
            <span
              data-testid="ticket-aging"
              title={t`In this column for ${columnDays} days`}
              className="ms-auto text-[11px] tabular-nums text-warning"
            >
              {t`${columnDays}d`}
            </span>
          ) : null}
        </div>
        <span className="line-clamp-3 break-words text-[13.5px] font-medium" dir="auto">
          {ticket.title}
        </span>
        <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {assignee ? (
            <>
              <BotAvatar color={assignee.color} identity={assignee.id} size={14} />
              <span className="truncate">{assignee.name}</span>
              {working ? <WorkingIndicator label={t`${assignee.name} is working`} /> : null}
              {issue ? (
                <span
                  role="img"
                  data-testid="ticket-bot-issue"
                  aria-label={issue.message}
                  title={issue.message}
                  className="inline-flex shrink-0 text-destructive"
                >
                  <AlertTriangle size={12} strokeWidth={1.9} />
                </span>
              ) : null}
              {overLimit ? (
                <span
                  data-testid="ticket-wip-warning"
                  title={t`${assignee.name} has more than ${TICKET_WIP_LIMIT} tickets in progress`}
                  className="shrink-0 text-warning"
                >
                  <Trans>over limit</Trans>
                </span>
              ) : null}
            </>
          ) : (
            <span className="truncate">
              <Trans>Unassigned</Trans>
            </span>
          )}
        </span>
      </button>
      <div className="absolute end-1 top-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={t`Move ticket`}
                className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
              />
            }
          >
            <MoreHorizontal size={14} strokeWidth={1.9} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {TICKET_STATUSES.map((status) => (
              <DropdownMenuItem
                key={status}
                disabled={status === ticket.status}
                onClick={() => onMove(ticket, status)}
              >
                {labels[status]}
                {status === ticket.status ? <Check className="ms-auto" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** A wake only works todo/doing tickets, so other columns never show the bot as busy. */
function isActionableStatus(status: TicketStatus): boolean {
  return status === "todo" || status === "doing";
}

function WorkingIndicator({ label }: { label: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      data-testid="ticket-working"
      className="inline-flex size-2 shrink-0 animate-pulse rounded-full bg-primary"
    />
  );
}

function ReasonDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingMove | null;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const labels = useTicketStatusLabels();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (pending) {
      setReason("");
      setBusy(false);
    }
  }, [pending]);

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {pending ? t`Move to ${labels[pending.status]}` : <Trans>Move ticket</Trans>}
          </DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = reason.trim();
            if (!trimmed || busy) return;
            setBusy(true);
            void onConfirm(trimmed).finally(() => setBusy(false));
          }}
        >
          <p className="text-[13px] text-muted-foreground">{pending?.message}</p>
          <Textarea
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t`Reason`}
            aria-label={t`Reason`}
            data-testid="move-reason-input"
            maxLength={2000}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={busy || !reason.trim()}>
              <Trans>Move</Trans>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewTicketDialog({
  open,
  onOpenChange,
  bots,
  boardId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bots: Bot[];
  boardId: string | null;
  onCreated: () => void;
}) {
  const { t } = useLingui();
  const priorityLabels = useTicketPriorityLabels();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteriaText, setCriteriaText] = useState("");
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [ownerBotId, setOwnerBotId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setDescription("");
      setCriteriaText("");
      setPriority("normal");
      setOwnerBotId(bots[0]?.id ?? "");
      setError(null);
      setBusy(false);
    }
  }, [open, bots]);

  async function submit() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || !ownerBotId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.tickets.create({
        boardId: boardId ?? undefined,
        title: trimmedTitle,
        description: description.trim() || undefined,
        acceptanceCriteria: criteriaFromText(criteriaText),
        priority,
        assigneeBotId: ownerBotId,
      });
      onOpenChange(false);
      onCreated();
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : t`Could not create the ticket.`,
      );
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>New ticket</Trans>
          </DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t`Title`}
            aria-label={t`Title`}
            maxLength={TICKET_TITLE_MAX_LENGTH}
            required
          />
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t`Description (Markdown supported)`}
            aria-label={t`Description`}
            maxLength={TICKET_DESCRIPTION_MAX_LENGTH}
          />
          <Textarea
            value={criteriaText}
            onChange={(event) => setCriteriaText(event.target.value)}
            placeholder={t`Acceptance criteria (one per line, Markdown supported)`}
            aria-label={t`Acceptance criteria`}
          />
          <NativeSelect
            aria-label={t`Priority`}
            value={priority}
            onChange={(event) => setPriority(event.target.value as TicketPriority)}
          >
            {TICKET_PRIORITIES.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {priorityLabels[value]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label={t`Owner`}
            value={ownerBotId}
            onChange={(event) => setOwnerBotId(event.target.value)}
            required
          >
            {bots.map((bot) => (
              <NativeSelectOption key={bot.id} value={bot.id}>
                {bot.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={busy || !title.trim() || !ownerBotId}>
              {busy ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function criteriaToText(criteria: readonly { text: string }[]): string {
  return criteria.map((item) => item.text).join("\n");
}

/** One criterion per line; blank lines and a leading list marker are dropped. */
function criteriaFromText(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

/** A bot mentioned in the history: its avatar and name. */
function BotChip({ bot, fallback }: { bot: Bot | undefined; fallback: string }) {
  if (!bot) return <span className="font-medium">{fallback}</span>;
  return (
    <span className="inline-flex items-center gap-1 align-middle font-medium">
      <BotAvatar color={bot.color} identity={bot.id} size={14} />
      {bot.name}
    </span>
  );
}

/** Turn a history entry into one readable line: who did what, with bot avatars. */
function useTicketEventDescriber(botsById: Map<string, Bot>) {
  const { t } = useLingui();
  const statusLabels = useTicketStatusLabels();
  const priorityLabels = useTicketPriorityLabels();
  return useCallback(
    (event: TicketEvent): ReactNode => {
      const botChip = (id: unknown, fallback: string) => (
        <BotChip bot={typeof id === "string" ? botsById.get(id) : undefined} fallback={fallback} />
      );
      const actor = event.actorBotId ? (
        botChip(event.actorBotId, t`A bot`)
      ) : (
        <span className="font-medium">{event.actorUserId ? t`You` : t`System`}</span>
      );
      const data = event.data;
      const status = (value: unknown) =>
        typeof value === "string" && value in statusLabels
          ? statusLabels[value as TicketStatus]
          : String(value ?? "");
      const priority = (value: unknown) =>
        typeof value === "string" && value in priorityLabels
          ? priorityLabels[value as TicketPriority]
          : String(value ?? "");
      const from = data.from;
      const to = data.to;
      const text = String(data.text ?? "");
      switch (event.type) {
        case "created":
          return <Trans>{actor} created the ticket</Trans>;
        case "status_changed": {
          const fromLabel = status(from);
          const toLabel = status(to);
          return (
            <Trans>
              {actor} moved it from {fromLabel} to {toLabel}
            </Trans>
          );
        }
        case "assignee_changed": {
          const fromChip = botChip(from, t`nobody`);
          const toChip = botChip(to, t`nobody`);
          return (
            <Trans>
              {actor} reassigned it from {fromChip} to {toChip}
            </Trans>
          );
        }
        case "priority_changed": {
          const fromLabel = priority(from);
          const toLabel = priority(to);
          return (
            <Trans>
              {actor} changed priority from {fromLabel} to {toLabel}
            </Trans>
          );
        }
        case "title_changed": {
          const title = String(to ?? "");
          return (
            <Trans>
              {actor} renamed it to "{title}"
            </Trans>
          );
        }
        case "description_changed":
          return <Trans>{actor} edited the description</Trans>;
        case "criteria_changed":
          return <Trans>{actor} edited the acceptance criteria</Trans>;
        case "criterion_checked":
          return (
            <Trans>
              {actor} checked "{text}"
            </Trans>
          );
        case "criterion_unchecked":
          return (
            <Trans>
              {actor} unchecked "{text}"
            </Trans>
          );
        case "commented":
          return <Trans>{actor} commented</Trans>;
        case "override": {
          const reason = String(data.reason ?? "");
          return (
            <Trans>
              {actor} overrode the open criteria: {reason}
            </Trans>
          );
        }
      }
    },
    [botsById, statusLabels, priorityLabels, t],
  );
}

function TicketDetail({
  ticket,
  bots,
  working,
  onRequestMove,
  onChanged,
  refreshToken,
}: {
  ticket: Ticket;
  bots: Bot[];
  working: boolean;
  onRequestMove: (status: TicketStatus) => void;
  onChanged: () => void;
  refreshToken: number;
}) {
  const { t } = useLingui();
  const labels = useTicketStatusLabels();
  const priorityLabels = useTicketPriorityLabels();
  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const owner = ticket.assigneeBotId ? botsById.get(ticket.assigneeBotId) : undefined;
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description ?? "");
  const [criteriaText, setCriteriaText] = useState(criteriaToText(ticket.acceptanceCriteria));
  const [editingDescription, setEditingDescription] = useState(false);
  const [comments, setComments] = useState<TicketComment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commentsRef = useRef<HTMLDivElement>(null);
  // Overlapping reloads can finish out of order; only the newest one may
  // write state, so an older response cannot replace a newer one.
  const commentsGeneration = useRef(0);
  const eventsGeneration = useRef(0);
  const [panel, setPanel] = useState<"comments" | "history">("comments");
  const [events, setEvents] = useState<TicketEvent[] | null>(null);
  const describeEvent = useTicketEventDescriber(botsById);

  useEffect(() => {
    setTitle(ticket.title);
    setDescription(ticket.description ?? "");
    setCriteriaText(criteriaToText(ticket.acceptanceCriteria));
    setEditingDescription(false);
  }, [ticket.id, ticket.title, ticket.description, ticket.acceptanceCriteria]);

  const loadComments = useCallback(async () => {
    const current = ++commentsGeneration.current;
    try {
      const list = await rpc.tickets.comments({ ticketId: ticket.id });
      if (current !== commentsGeneration.current) return;
      setComments(list);
    } catch (commentsError) {
      if (current !== commentsGeneration.current) return;
      setError(
        commentsError instanceof Error ? commentsError.message : t`Could not load comments.`,
      );
    }
  }, [ticket.id, t]);

  const loadEvents = useCallback(async () => {
    const current = ++eventsGeneration.current;
    try {
      const list = await rpc.tickets.events({ ticketId: ticket.id });
      if (current !== eventsGeneration.current) return;
      setEvents(list);
    } catch {
      // History is secondary; keep whatever was loaded.
    }
  }, [ticket.id]);

  useEffect(() => {
    setComments(null);
    setEvents(null);
    setError(null);
    void loadComments();
    void loadEvents();
  }, [loadComments, loadEvents]);

  // A live board change refreshes comments without clearing the open detail
  // (clearing would flash the loading state and could drop an unsent draft).
  useEffect(() => {
    if (refreshToken === 0) return;
    void loadComments();
    void loadEvents();
  }, [refreshToken, loadComments, loadEvents]);

  useEffect(() => {
    const node = commentsRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [comments]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await Promise.all([loadComments(), loadEvents()]);
      onChanged();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t`Something went wrong.`);
    } finally {
      setBusy(false);
    }
  }

  const saveDetails = () =>
    run(async () => {
      await rpc.tickets.update({
        id: ticket.id,
        title: title.trim(),
        description: description.trim() || null,
        acceptanceCriteria: criteriaFromText(criteriaText),
      });
      setEditingDescription(false);
    });

  const addComment = () => {
    const body = draft.trim();
    if (!body) return Promise.resolve();
    return run(async () => {
      await rpc.tickets.comment({ ticketId: ticket.id, body });
      setDraft("");
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogHeader>
        <DialogTitle className="sr-only">{ticket.title}</DialogTitle>
      </DialogHeader>
      <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto md:grid-cols-2 md:overflow-hidden">
        <div className="flex min-w-0 flex-col gap-3 md:min-h-0 md:overflow-y-auto">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] text-muted-foreground">{ticket.ref}</span>
          </div>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label={t`Title`}
            maxLength={TICKET_TITLE_MAX_LENGTH}
            className="text-[15px] font-medium"
          />
          <div className="flex flex-col gap-2">
            <NativeSelect
              aria-label={t`Status`}
              value={ticket.status}
              onChange={(event) => onRequestMove(event.target.value as TicketStatus)}
            >
              {TICKET_STATUSES.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {labels[value]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={t`Owner`}
              value={ticket.assigneeBotId ?? ""}
              onChange={(event) => {
                const ownerBotId = event.target.value;
                if (ownerBotId)
                  void run(() => rpc.tickets.update({ id: ticket.id, assigneeBotId: ownerBotId }));
              }}
            >
              {owner ? null : (
                <NativeSelectOption value="" disabled>
                  <Trans>Unassigned</Trans>
                </NativeSelectOption>
              )}
              {bots.map((bot) => (
                <NativeSelectOption key={bot.id} value={bot.id}>
                  {bot.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-end">
              {editingDescription ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingDescription(true)}
                  data-testid="ticket-description-edit"
                >
                  <Trans>Edit</Trans>
                </Button>
              )}
            </div>
            {editingDescription ? (
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t`Description (Markdown supported)`}
                aria-label={t`Description`}
                maxLength={TICKET_DESCRIPTION_MAX_LENGTH}
                data-testid="ticket-description-input"
                className="max-h-[60vh] min-h-40"
              />
            ) : (
              <div
                className="break-words text-[13.5px] leading-relaxed"
                dir="auto"
                data-testid="ticket-description"
              >
                <ChatMarkdown>{description}</ChatMarkdown>
              </div>
            )}
            <span className="text-[12px] font-medium text-foreground/80">
              <Trans>Acceptance criteria</Trans>
            </span>
            {editingDescription ? (
              <Textarea
                value={criteriaText}
                onChange={(event) => setCriteriaText(event.target.value)}
                placeholder={t`One criterion per line (Markdown supported)`}
                aria-label={t`Acceptance criteria`}
                data-testid="ticket-criteria-input"
                className="max-h-[40vh] min-h-28"
              />
            ) : null}
            {editingDescription ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void saveDetails()}
                  disabled={busy || !title.trim()}
                  data-testid="ticket-description-save"
                >
                  <Trans>Save</Trans>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDescription(ticket.description ?? "");
                    setCriteriaText(criteriaToText(ticket.acceptanceCriteria));
                    setEditingDescription(false);
                  }}
                  data-testid="ticket-description-cancel"
                >
                  <Trans>Cancel</Trans>
                </Button>
              </div>
            ) : null}
            {editingDescription ? null : ticket.acceptanceCriteria.length > 0 ? (
              <ul
                className="space-y-1.5 text-[13.5px] leading-relaxed"
                data-testid="ticket-criteria"
              >
                {ticket.acceptanceCriteria.map((criterion, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: criteria are an ordered, non-unique list
                  <li key={index} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={criterion.done}
                      disabled={busy}
                      aria-label={criterion.text}
                      data-testid={`ticket-criterion-${index}`}
                      className="mt-1 size-3.5 shrink-0 accent-primary"
                      onChange={(event) =>
                        void run(() =>
                          rpc.tickets.update({
                            id: ticket.id,
                            // Only the toggled criterion carries an explicit
                            // `done`; the rest stay plain text. The server keeps
                            // its stored state for those, so a check that the
                            // agent made meanwhile is not undone by this write.
                            acceptanceCriteria: ticket.acceptanceCriteria.map((item, i) =>
                              i === index
                                ? { text: item.text, done: event.target.checked }
                                : item.text,
                            ),
                          }),
                        )
                      }
                    />
                    <div
                      className={`min-w-0 break-words [&_p]:my-0 ${
                        criterion.done ? "text-muted-foreground line-through" : ""
                      }`}
                      dir="auto"
                    >
                      <ChatMarkdown>{criterion.text}</ChatMarkdown>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-[13px] text-muted-foreground/80">
                <Trans>None yet</Trans>
              </span>
            )}
          </div>
          <NativeSelect
            aria-label={t`Priority`}
            value={ticket.priority}
            onChange={(event) =>
              void run(() =>
                rpc.tickets.update({
                  id: ticket.id,
                  priority: event.target.value as TicketPriority,
                }),
              )
            }
          >
            {TICKET_PRIORITIES.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {priorityLabels[value]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void saveDetails()}
              disabled={busy || !title.trim()}
            >
              <Trans>Save</Trans>
            </Button>
            {owner ? (
              <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <BotAvatar color={owner.color} identity={owner.id} size={14} />
                <span className="truncate">{owner.name}</span>
                {working ? <WorkingIndicator label={t`${owner.name} is working`} /> : null}
              </span>
            ) : null}
          </div>
          {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
        </div>

        <div className="flex min-w-0 flex-col gap-3 md:min-h-0 md:overflow-hidden">
          <div role="tablist" className="flex gap-1">
            {(["comments", "history"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={panel === value}
                data-testid={`ticket-tab-${value}`}
                onClick={() => setPanel(value)}
                className={`rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
                  panel === value
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50"
                }`}
              >
                {value === "comments" ? <Trans>Comments</Trans> : <Trans>History</Trans>}
              </button>
            ))}
          </div>
          {panel === "history" ? (
            <ol
              data-testid="ticket-history"
              className="flex min-h-40 flex-1 flex-col gap-2 overflow-y-auto"
            >
              {events === null ? (
                <li className="text-[13px] text-muted-foreground/80">
                  <Trans>Loading…</Trans>
                </li>
              ) : events.length === 0 ? (
                <li className="text-[13px] text-muted-foreground/80">
                  <Trans>No history yet</Trans>
                </li>
              ) : (
                events.map((event) => (
                  <li key={event.id} className="text-[13px]">
                    <span>{describeEvent(event)}</span>
                    <span className="ms-2 text-[11px] text-muted-foreground">
                      {formatRelativeTime(event.createdAt)}
                    </span>
                  </li>
                ))
              )}
            </ol>
          ) : null}
          <div
            ref={commentsRef}
            hidden={panel !== "comments"}
            data-testid="ticket-comments"
            className="flex min-h-40 flex-1 flex-col gap-2 overflow-y-auto"
          >
            {comments === null ? (
              <span className="text-[13px] text-muted-foreground/80">
                <Trans>Loading…</Trans>
              </span>
            ) : comments.length > 0 ? (
              comments.map((comment) => (
                <div
                  key={comment.id}
                  className="rounded-lg border border-border bg-card/40 px-3 py-2"
                >
                  <span className="text-[12px] font-medium text-foreground/80">
                    {comment.authorBotId
                      ? (botsById.get(comment.authorBotId)?.name ?? t`Bot`)
                      : t`You`}
                  </span>
                  <div className="mt-0.5 break-words text-[13px]" dir="auto">
                    <ChatMarkdown>{comment.body}</ChatMarkdown>
                  </div>
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    {formatRelativeTime(comment.createdAt)}
                  </span>
                </div>
              ))
            ) : null}
          </div>
          <form
            hidden={panel !== "comments"}
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addComment();
            }}
          >
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t`Add a comment`}
              aria-label={t`Comment`}
              className="min-h-14"
            />
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
                {busy ? <Trans>Adding…</Trans> : <Trans>Comment</Trans>}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
