import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Bot, Ticket, TicketPriority, TicketStatus } from "@rakazo/contracts";
import {
  TICKET_COMMENT_MAX_LENGTH,
  TICKET_DESCRIPTION_MAX_LENGTH,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TITLE_MAX_LENGTH,
} from "@rakazo/contracts";
import { abortableDelay, isRetryableError, reconnectDelayMs, retryDelayMs } from "@rakazo/core";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import {
  Button,
  buttonVariants,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  OptionSelect,
  Textarea,
} from "@rakazo/ui-web";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, MessageCircle } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { IconTooltip } from "../../components/IconTooltip";
import { WindowChrome } from "../../components/WindowChrome";
import { formatRelativeTime } from "../../lib/locale/relative-time";
import { desktopBridge } from "../../lib/platform/desktop";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { rpc } from "../../lib/query/rpc";
import { errorText } from "../../lib/query/user-error";
import { useTicketPriorityLabels } from "./ticket-priority";
import { useTicketStatusLabels } from "./ticket-status";

export function BoardPage() {
  const { t } = useLingui();
  const statuses = useTicketStatusLabels();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const ticketsOptions = queries.tickets.list.queryOptions({ input: {} });
  const ticketsQuery = useQuery(ticketsOptions);
  const botsQuery = useQuery(queries.bots.list.queryOptions());
  const tickets = ticketsQuery.data?.tickets ?? [];
  const bots = botsQuery.data ?? [];
  const [selected, setSelected] = useState<Ticket | "new" | null>(null);
  const [streamError, setError] = useState("");
  const loadFailed = ticketsQuery.error ?? botsQuery.error;
  const error = streamError || (loadFailed ? errorText(loadFailed) : "");

  useEffect(() => {
    let currentController: AbortController | undefined;
    let active = true;
    // Live events refresh the board and any open ticket's comments.
    const refreshComments = (ticketId?: string) =>
      void queryClient.invalidateQueries({
        queryKey: ticketId
          ? queries.tickets.comments.queryKey({ input: { ticketId } })
          : queries.tickets.comments.key(),
      });
    const stopped = new AbortController();
    void (async () => {
      while (active) {
        const controller = new AbortController();
        currentController = controller;
        let failure: unknown;
        let opened = false;
        try {
          const stream = await rpc.boards.subscribe(undefined, {
            signal: controller.signal,
          });
          if (!active) return;
          await fetchFresh(queryClient, ticketsOptions);
          if (!active) return;
          refreshComments();
          setError("");
          opened = true;
          for await (const event of stream) {
            if (!active) return;
            refreshComments(event.ticketId);
            await fetchFresh(queryClient, ticketsOptions);
          }
        } catch (cause) {
          failure = cause;
          if (active) setError(errorText(cause));
        } finally {
          controller.abort();
        }
        if (!active || !isRetryableError(failure)) return;
        await abortableDelay(
          opened ? reconnectDelayMs(failure) : retryDelayMs(failure, 1_000),
          stopped.signal,
        );
      }
    })();
    return () => {
      active = false;
      currentController?.abort();
      stopped.abort();
    };
  }, [queries]);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="app-drag flex items-center gap-3 border-b px-4 py-3">
        {/* This route is the window's leading edge, so Electron window controls sit in the header. */}
        {desktopBridge() ? <WindowChrome /> : null}
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <IconTooltip label={t`Back`}>
            <Link
              to="/app"
              aria-label={t`Back`}
              className={buttonVariants({
                variant: "ghost",
                size: "icon",
                className: "app-no-drag text-muted-foreground",
              })}
            >
              <ChevronLeft />
            </Link>
          </IconTooltip>
          <h1 className="font-medium">
            <Trans>Board</Trans>
          </h1>
        </div>
        <Button
          className="app-no-drag"
          onClick={() => setSelected("new")}
          disabled={bots.length === 0}
        >
          <Trans>New ticket</Trans>
        </Button>
      </header>
      {error ? (
        <p role="alert" className="px-4 py-2 text-body text-destructive">
          {error}
        </p>
      ) : null}
      <main className="relative min-h-0 min-w-0 flex-1 overflow-auto p-4">
        <div data-testid="board-columns" className="flex min-h-full gap-3">
          {TICKET_STATUSES.map((status) => (
            <section key={status} className="min-w-40 flex-1 space-y-2">
              <h2 className="px-1 text-body font-medium">{statuses[status]}</h2>
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
                    <span className="text-label text-muted-foreground">{ticket.ref}</span>
                    <span>{ticket.title}</span>
                    <span className="text-label text-muted-foreground">
                      {bots.find((bot) => bot.id === ticket.assigneeBotId)?.name}
                    </span>
                  </Button>
                ))}
            </section>
          ))}
        </div>
        {tickets.length === 0 && !error ? (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-body text-muted-foreground">
            <Trans>No tickets yet</Trans>
          </p>
        ) : null}
      </main>
      {selected ? (
        <TicketDialog
          key={selected === "new" ? "new" : selected.id}
          ticket={selected === "new" ? null : selected}
          bots={bots}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

function TicketDialog({
  ticket,
  bots,
  onClose,
}: {
  ticket: Ticket | null;
  bots: Bot[];
  onClose: () => void;
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
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const commentsOptions = queries.tickets.comments.queryOptions({
    input: ticket ? { ticketId: ticket.id } : skipToken,
  });
  const commentsQuery = useQuery(commentsOptions);
  const comments = commentsQuery.data ?? [];
  const [body, setBody] = useState("");
  const saving = useSave({
    save: async (_input, rpc) => {
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
      else
        await rpc.tickets.create({
          title,
          description,
          assigneeBotId: owner,
          priority,
        });
    },
    stale: [queries.tickets.list.key()],
    closesScreen: true,
    onSaved: () => onClose(),
  });
  const commenting = useSave({
    save: async (text: string, rpc) => {
      if (!ticket) return;
      const row = await rpc.tickets.comment({ ticketId: ticket.id, body: text });
      // A list already on screen shows the comment at once, unless a read already brought it.
      if (queryClient.getQueryData(commentsOptions.queryKey)) {
        await writeSaved(queryClient, commentsOptions.queryKey, (previous = []) =>
          previous.some((item) => item.id === row.id) ? previous : [...previous, row],
        );
      } else {
        // A first read still in flight was sent before the post, so it is not waited for.
        await queryClient.cancelQueries({ queryKey: commentsOptions.queryKey, exact: true });
      }
      // Listed now, so the box empties before the list is read again.
      setBody("");
    },
    stale: [commentsOptions.queryKey],
  });
  const ownerBot = bots.find((bot) => bot.id === owner);
  const busy = saving.pending || commenting.pending;
  const failure = saving.error ?? commenting.error;
  const shownError = failure
    ? errorText(failure)
    : commentsQuery.error
      ? errorText(commentsQuery.error)
      : "";

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
          onSubmit={(event) => {
            event.preventDefault();
            commenting.reset();
            saving.run();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${formId}-title`}>
                <Trans>Title</Trans>
              </FieldLabel>
              <Input
                id={`${formId}-title`}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={TICKET_TITLE_MAX_LENGTH}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-description`}>
                <Trans>Description</Trans>
              </FieldLabel>
              <Textarea
                id={`${formId}-description`}
                data-testid="ticket-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={TICKET_DESCRIPTION_MAX_LENGTH}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-owner`}>
                <Trans>Owner</Trans>
              </FieldLabel>
              <div className="flex items-center gap-2">
                <OptionSelect
                  id={`${formId}-owner`}
                  className="min-w-0 flex-1"
                  value={owner || null}
                  onValueChange={setOwner}
                  required
                  options={bots.map((bot) => ({ value: bot.id, label: bot.name }))}
                />
                {ownerBot ? (
                  <IconTooltip label={t`Chat with ${ownerBot.name}`}>
                    <Link
                      to={`/app/${ownerBot.id}`}
                      aria-label={t`Chat with ${ownerBot.name}`}
                      className={buttonVariants({
                        variant: "ghost",
                        size: "icon",
                        className: "text-muted-foreground",
                      })}
                    >
                      <MessageCircle />
                    </Link>
                  </IconTooltip>
                ) : null}
              </div>
            </Field>
            {ticket ? (
              <Field>
                <FieldLabel htmlFor={`${formId}-status`}>
                  <Trans>Status</Trans>
                </FieldLabel>
                <OptionSelect<TicketStatus>
                  id={`${formId}-status`}
                  value={status}
                  onValueChange={setStatus}
                  options={TICKET_STATUSES.map((value) => ({ value, label: statuses[value] }))}
                />
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`${formId}-priority`}>
                <Trans>Priority</Trans>
              </FieldLabel>
              <OptionSelect<TicketPriority>
                id={`${formId}-priority`}
                value={priority}
                onValueChange={setPriority}
                options={TICKET_PRIORITIES.map((value) => ({ value, label: priorities[value] }))}
              />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" disabled={busy || !title.trim() || !owner}>
                {ticket ? t`Save` : t`Create`}
              </Button>
            </div>
          </FieldGroup>
        </form>
        {ticket ? (
          <div data-testid="ticket-comments" className="space-y-3 border-t pt-3">
            {comments.map((row) => (
              <div key={row.id} className="text-body">
                <div className="mb-1 flex items-center justify-between gap-3 text-label text-muted-foreground">
                  {row.authorBotId && bots.some((bot) => bot.id === row.authorBotId) ? (
                    <Link to={`/app/${row.authorBotId}`} className="hover:text-foreground">
                      {row.authorName}
                    </Link>
                  ) : (
                    <span>{row.authorName}</span>
                  )}
                  <time dateTime={row.createdAt}>{formatRelativeTime(row.createdAt)}</time>
                </div>
                <ChatMarkdown>{row.body}</ChatMarkdown>
              </div>
            ))}
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                saving.reset();
                commenting.run(body);
              }}
            >
              <Textarea
                aria-label={t`Comment`}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                maxLength={TICKET_COMMENT_MAX_LENGTH}
              />
              <div className="flex justify-end">
                <Button type="submit" disabled={busy || !body.trim()}>
                  <Trans>Comment</Trans>
                </Button>
              </div>
            </form>
          </div>
        ) : null}
        {shownError ? (
          <p role="alert" className="text-body text-destructive">
            {shownError}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
