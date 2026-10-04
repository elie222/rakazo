import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type {
  Board,
  Bot,
  Ticket,
  TicketComment,
  TicketPriority,
  TicketStatus,
} from "@rakazo/contracts";
import {
  TICKET_DESCRIPTION_MAX_LENGTH,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TITLE_MAX_LENGTH,
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
import { Check, ChevronLeft, ChevronRight, MoreHorizontal, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { desktopBridge } from "../lib/desktop";
import { formatRelativeTime } from "../lib/relative-time";
import { rpc } from "../lib/rpc";
import { useTicketPriorityLabels } from "../lib/ticket-priority";
import { useTicketStatusLabels } from "../lib/ticket-status";
import { WindowChrome } from "./WindowChrome";

const CLOSED_COLLAPSED_STORAGE_KEY = "rakazo:board-closed-collapsed";

function readClosedCollapsed(): boolean {
  try {
    return window.localStorage.getItem(CLOSED_COLLAPSED_STORAGE_KEY) !== "open";
  } catch {
    return true;
  }
}

function writeClosedCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(CLOSED_COLLAPSED_STORAGE_KEY, collapsed ? "collapsed" : "open");
  } catch {
    // Preference only; ignore storage failures.
  }
}

export function BoardPage() {
  const { t } = useLingui();
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [workingBotIds, setWorkingBotIds] = useState<ReadonlySet<string>>(new Set());
  const [bots, setBots] = useState<Bot[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [closedCollapsed, setClosedCollapsed] = useState(readClosedCollapsed);
  const [boardVersion, setBoardVersion] = useState(0);
  const generation = useRef(0);

  const activeBoardId = selectedBoardId ?? boards?.[0]?.id ?? null;
  const board = boards?.find((item) => item.id === activeBoardId) ?? null;

  const loadTickets = useCallback(
    async (boardId: string) => {
      const current = ++generation.current;
      try {
        const next = await rpc.tickets.list({ boardId });
        if (current !== generation.current) return;
        setTickets(next.tickets);
        setWorkingBotIds(new Set(next.workingBotIds));
        setLoadError(null);
      } catch (error) {
        if (current !== generation.current) return;
        setLoadError(error instanceof Error ? error.message : t`Could not load the board.`);
      }
    },
    [t],
  );

  useEffect(() => {
    void (async () => {
      try {
        const next = await rpc.boards.list();
        setBoards(next);
        setSelectedBoardId((previous) => previous ?? next[0]?.id ?? null);
        setLoadError(null);
      } catch (error) {
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
      void rpc.boards
        .list()
        .then((next) => {
          if (!disposed) setBoards(next);
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

  const toggleClosed = useCallback(() => {
    setClosedCollapsed((previous) => {
      const next = !previous;
      writeClosedCollapsed(next);
      return next;
    });
  }, []);

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
            workingBotIds={workingBotIds}
            closedCollapsed={closedCollapsed}
            onToggleClosed={toggleClosed}
            onOpen={(id) => setSelectedId(id)}
            onMove={async (id, status) => {
              setMoveError(null);
              try {
                await rpc.tickets.update({ id, status });
              } catch (error) {
                setMoveError(
                  error instanceof Error ? error.message : t`Could not move the ticket.`,
                );
              } finally {
                reload();
              }
            }}
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
              working={selected.assigneeBotId ? workingBotIds.has(selected.assigneeBotId) : false}
              onChanged={reload}
              refreshToken={boardVersion}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BoardColumns({
  tickets,
  botsById,
  workingBotIds,
  closedCollapsed,
  onToggleClosed,
  onOpen,
  onMove,
}: {
  tickets: Ticket[];
  botsById: Map<string, Bot>;
  workingBotIds: ReadonlySet<string>;
  closedCollapsed: boolean;
  onToggleClosed: () => void;
  onOpen: (id: string) => void;
  onMove: (id: string, status: TicketStatus) => void;
}) {
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
        const collapsible = column.status === "closed";
        const collapsed = collapsible && closedCollapsed;
        return (
          <BoardColumn
            key={column.status}
            status={column.status}
            tickets={column.tickets}
            collapsed={collapsed}
            onToggle={collapsible ? onToggleClosed : undefined}
            botsById={botsById}
            workingBotIds={workingBotIds}
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
  workingBotIds,
  onOpen,
  onMove,
}: {
  status: TicketStatus;
  tickets: Ticket[];
  collapsed: boolean;
  onToggle?: () => void;
  botsById: Map<string, Bot>;
  workingBotIds: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onMove: (id: string, status: TicketStatus) => void;
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
            working={ticket.assigneeBotId ? workingBotIds.has(ticket.assigneeBotId) : false}
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
  onOpen,
  onMove,
}: {
  ticket: Ticket;
  assignee: Bot | undefined;
  working: boolean;
  onOpen: (id: string) => void;
  onMove: (id: string, status: TicketStatus) => void;
}) {
  const { t } = useLingui();
  const labels = useTicketStatusLabels();
  const priorityLabels = useTicketPriorityLabels();
  const showPriority = ticket.priority === "high" || ticket.priority === "urgent";
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
        </div>
        <span className="line-clamp-3 break-words text-[13.5px] font-medium" dir="auto">
          {ticket.title}
        </span>
        <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {assignee ? (
            <>
              <BotAvatar
                color={assignee.color}
                identity={assignee.id}
                size={14}
                status={assignee.status}
              />
              <span className="truncate">{assignee.name}</span>
              {working ? <WorkingIndicator label={t`${assignee.name} is working`} /> : null}
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
                onClick={() => onMove(ticket.id, status)}
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
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [ownerBotId, setOwnerBotId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setDescription("");
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
            placeholder={t`Description`}
            aria-label={t`Description`}
            maxLength={TICKET_DESCRIPTION_MAX_LENGTH}
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

function TicketDetail({
  ticket,
  bots,
  working,
  onChanged,
  refreshToken,
}: {
  ticket: Ticket;
  bots: Bot[];
  working: boolean;
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
  const [editingDescription, setEditingDescription] = useState(false);
  const [comments, setComments] = useState<TicketComment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commentsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTitle(ticket.title);
    setDescription(ticket.description ?? "");
    setEditingDescription(false);
  }, [ticket.id, ticket.title, ticket.description]);

  const loadComments = useCallback(async () => {
    try {
      const list = await rpc.tickets.comments({ ticketId: ticket.id });
      setComments(list);
    } catch (commentsError) {
      setError(
        commentsError instanceof Error ? commentsError.message : t`Could not load comments.`,
      );
    }
  }, [ticket.id, t]);

  useEffect(() => {
    setComments(null);
    setError(null);
    void loadComments();
  }, [loadComments]);

  // A live board change refreshes comments without clearing the open detail
  // (clearing would flash the loading state and could drop an unsent draft).
  useEffect(() => {
    if (refreshToken === 0) return;
    void loadComments();
  }, [refreshToken, loadComments]);

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
      await loadComments();
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
              onChange={(event) =>
                void run(() =>
                  rpc.tickets.update({
                    id: ticket.id,
                    status: event.target.value as TicketStatus,
                  }),
                )
              }
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
                placeholder={t`Description`}
                aria-label={t`Description`}
                maxLength={TICKET_DESCRIPTION_MAX_LENGTH}
                data-testid="ticket-description-input"
                className="max-h-[60vh] min-h-56"
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
                <BotAvatar
                  color={owner.color}
                  identity={owner.id}
                  size={14}
                  status={owner.status}
                />
                <span className="truncate">{owner.name}</span>
                {working ? <WorkingIndicator label={t`${owner.name} is working`} /> : null}
              </span>
            ) : null}
          </div>
          {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
        </div>

        <div className="flex min-w-0 flex-col gap-3 md:min-h-0 md:overflow-hidden">
          <div
            ref={commentsRef}
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
