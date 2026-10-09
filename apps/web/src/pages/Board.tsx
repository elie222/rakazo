import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Bot, Ticket, TicketComment, TicketPriority, TicketStatus } from "@rakazo/contracts";
import {
  TICKET_COMMENT_MAX_LENGTH,
  TICKET_DESCRIPTION_MAX_LENGTH,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TITLE_MAX_LENGTH,
} from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from "@rakazo/ui-web";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { rpc } from "../lib/rpc";
import { useTicketPriorityLabels } from "../lib/ticket-priority";
import { useTicketStatusLabels } from "../lib/ticket-status";
import { errorText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

export function BoardPage() {
  const { t } = useLingui();
  const statuses = useTicketStatusLabels();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [selected, setSelected] = useState<Ticket | "new" | null>(null);
  const [error, setError] = useState("");
  const [commentRefresh, setCommentRefresh] = useState<Record<string, number>>({});
  const reload = useCallback(async () => {
    const result = await rpc.tickets.list({});
    setTickets(result.tickets);
  }, []);

  useEffect(() => {
    let currentController: AbortController | undefined;
    let active = true;
    void Promise.all([rpc.tickets.list({}), rpc.bots.list()])
      .then(([result, owners]) => {
        if (!active) return;
        setTickets(result.tickets);
        setBots(owners);
      })
      .catch((cause) => {
        if (active) setError(errorText(cause));
      });
    let cancelRetry: (() => void) | undefined;
    void (async () => {
      while (active) {
        const controller = new AbortController();
        currentController = controller;
        try {
          const stream = await rpc.boards.subscribe(undefined, { signal: controller.signal });
          if (!active) return;
          const result = await rpc.tickets.list({});
          if (!active) return;
          setTickets(result.tickets);
          setCommentRefresh((previous) => ({
            ...previous,
            "*": (previous["*"] ?? 0) + 1,
          }));
          setError("");
          for await (const event of stream) {
            if (!active) return;
            setCommentRefresh((previous) => ({
              ...previous,
              [event.ticketId ?? "*"]: (previous[event.ticketId ?? "*"] ?? 0) + 1,
            }));
            const result = await rpc.tickets.list({});
            if (active) setTickets(result.tickets);
          }
        } catch (cause) {
          if (active) setError(errorText(cause));
        } finally {
          controller.abort();
        }
        if (!active) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          cancelRetry = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        cancelRetry = undefined;
      }
    })();
    return () => {
      active = false;
      currentController?.abort();
      cancelRetry?.();
    };
  }, []);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Button variant="ghost" size="icon" render={<Link to="/app" />} aria-label={t`Back`}>
          <ChevronLeft />
        </Button>
        <h1 className="flex-1 font-medium">
          <Trans>Board</Trans>
        </h1>
        <Button onClick={() => setSelected("new")} disabled={bots.length === 0}>
          <Trans>New ticket</Trans>
        </Button>
      </header>
      {error ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <main data-testid="board-columns" className="flex min-h-0 flex-1 gap-3 overflow-auto p-4">
        {TICKET_STATUSES.map((status) => (
          <section key={status} className="w-64 shrink-0 space-y-2">
            <h2 className="px-1 text-sm font-medium">{statuses[status]}</h2>
            {tickets
              .filter((ticket) => ticket.status === status)
              .map((ticket) => (
                <Button
                  key={ticket.id}
                  data-testid={`board-card-${ticket.id}`}
                  variant="outline"
                  className="h-auto w-full flex-col items-start gap-1 whitespace-normal p-3 text-left font-normal"
                  onClick={() => setSelected(ticket)}
                >
                  <span className="text-xs text-muted-foreground">{ticket.ref}</span>
                  <span>{ticket.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {bots.find((bot) => bot.id === ticket.assigneeBotId)?.name}
                  </span>
                </Button>
              ))}
          </section>
        ))}
      </main>
      {selected ? (
        <TicketDialog
          key={selected === "new" ? "new" : selected.id}
          ticket={selected === "new" ? null : selected}
          bots={bots}
          commentRevision={
            (commentRefresh["*"] ?? 0) +
            (selected === "new" ? 0 : (commentRefresh[selected.id] ?? 0))
          }
          onClose={() => setSelected(null)}
          onSaved={reload}
        />
      ) : null}
    </div>
  );
}

function TicketDialog({
  ticket,
  bots,
  onClose,
  onSaved,
  commentRevision,
}: {
  commentRevision?: number;
  ticket: Ticket | null;
  bots: Bot[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLingui();
  const formId = useId();
  const statuses = useTicketStatusLabels();
  const priorities = useTicketPriorityLabels();
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [description, setDescription] = useState(ticket?.description ?? "");
  const [owner, setOwner] = useState(ticket?.assigneeBotId ?? bots[0]?.id ?? "");
  const [status, setStatus] = useState<TicketStatus>(ticket?.status ?? "todo");
  const [priority, setPriority] = useState<TicketPriority>(ticket?.priority ?? "normal");
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!ticket) return;
    let active = true;
    void rpc.tickets
      .comments({ ticketId: ticket.id })
      .then((rows) => {
        if (active) setComments(rows);
      })
      .catch((cause) => {
        if (active) setError(errorText(cause));
      });
    return () => {
      active = false;
    };
  }, [ticket, commentRevision]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      if (ticket)
        await rpc.tickets.update({
          id: ticket.id,
          ...(title !== ticket.title ? { title } : {}),
          ...(description !== (ticket.description ?? "") ? { description } : {}),
          ...(owner !== (ticket.assigneeBotId ?? bots[0]?.id ?? "")
            ? { assigneeBotId: owner }
            : {}),
          ...(status !== ticket.status ? { status } : {}),
          ...(priority !== ticket.priority ? { priority } : {}),
        });
      else await rpc.tickets.create({ title, description, assigneeBotId: owner, priority });
      await onSaved();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  async function comment() {
    if (!ticket) return;
    setBusy(true);
    setError("");
    try {
      const row = await rpc.tickets.comment({ ticketId: ticket.id, body });
      setComments((previous) => [...previous, row]);
      setBody("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{ticket?.title ?? t`New ticket`}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor={`${formId}-title`} className="block space-y-1 text-sm">
            <span>
              <Trans>Title</Trans>
            </span>
            <Input
              id={`${formId}-title`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={TICKET_TITLE_MAX_LENGTH}
              required
            />
          </label>
          <label htmlFor={`${formId}-description`} className="block space-y-1 text-sm">
            <span>
              <Trans>Description</Trans>
            </span>
            <Textarea
              id={`${formId}-description`}
              data-testid="ticket-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={TICKET_DESCRIPTION_MAX_LENGTH}
            />
          </label>
          <label htmlFor={`${formId}-owner`} className="block space-y-1 text-sm">
            <span>
              <Trans>Owner</Trans>
            </span>
            <NativeSelect
              id={`${formId}-owner`}
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              required
            >
              {bots.map((bot) => (
                <NativeSelectOption key={bot.id} value={bot.id}>
                  {bot.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          {ticket ? (
            <label htmlFor={`${formId}-status`} className="block space-y-1 text-sm">
              <span>
                <Trans>Status</Trans>
              </span>
              <NativeSelect
                id={`${formId}-status`}
                value={status}
                onChange={(event) => setStatus(event.target.value as TicketStatus)}
              >
                {TICKET_STATUSES.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {statuses[value]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          ) : null}
          <label htmlFor={`${formId}-priority`} className="block space-y-1 text-sm">
            <span>
              <Trans>Priority</Trans>
            </span>
            <NativeSelect
              id={`${formId}-priority`}
              value={priority}
              onChange={(event) => setPriority(event.target.value as TicketPriority)}
            >
              {TICKET_PRIORITIES.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {priorities[value]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <div className="flex justify-end">
            <Button type="submit" disabled={busy || !title.trim() || !owner}>
              {ticket ? t`Save` : t`Create`}
            </Button>
          </div>
        </form>
        {ticket ? (
          <div data-testid="ticket-comments" className="space-y-3 border-t pt-3">
            {comments.map((row) => (
              <div key={row.id} className="text-sm">
                <ChatMarkdown>{row.body}</ChatMarkdown>
              </div>
            ))}
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void comment();
              }}
            >
              <Textarea
                aria-label={t`Comment`}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                maxLength={TICKET_COMMENT_MAX_LENGTH}
              />
              <Button type="submit" disabled={busy || !body.trim()}>
                <Trans>Comment</Trans>
              </Button>
            </form>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
