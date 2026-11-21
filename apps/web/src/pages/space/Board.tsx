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
  toast,
} from "@rakazo/ui-web";
import { isCancelledError, skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, MessageCircle } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { IconTooltip } from "../../components/IconTooltip";
import { WindowChrome } from "../../components/WindowChrome";
import { formatRelativeTime } from "../../lib/locale/relative-time";
import { desktopBridge } from "../../lib/platform/desktop";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { rpc } from "../../lib/query/rpc";
import { errorText } from "../../lib/query/user-error";
import { useAppRail } from "../shell/app-rail";
import { BoardColumns, TicketTable } from "./board-views";
import { useTicketPriorityLabels } from "./ticket-priority";
import { useTicketStatusLabels } from "./ticket-status";

type TicketChange = Pick<Ticket, "id"> &
  Partial<Pick<Ticket, "priority" | "status">> & { assigneeBotId?: string };

export function BoardPage() {
  const { t } = useLingui();
  // From md up the rail holds the window controls and the way back to chats.
  const rail = useAppRail();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "table" ? "table" : "kanban";
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const ticketsOptions = queries.tickets.list.queryOptions({ input: {} });
  const ticketsQuery = useQuery(ticketsOptions);
  const botsQuery = useQuery(queries.bots.list.queryOptions());
  const tickets = ticketsQuery.data?.tickets ?? [];
  const bots = botsQuery.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const creating = selectedId === "new";
  const change = useTicketChange();
  const pending = change.pending ? change.input : undefined;
  const shownTickets = pending
    ? tickets.map((ticket) => (ticket.id === pending.id ? { ...ticket, ...pending } : ticket))
    : tickets;
  const selected = shownTickets.find((ticket) => ticket.id === selectedId);
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
    async function refreshTickets() {
      try {
        await fetchFresh(queryClient, ticketsOptions);
      } catch (error) {
        // A save can replace this read with its own. Keep listening for the next change.
        if (!isCancelledError(error)) throw error;
      }
    }
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
          await refreshTickets();
          if (!active) return;
          refreshComments();
          setError("");
          opened = true;
          for await (const event of stream) {
            if (!active) return;
            refreshComments(event.ticketId);
            await refreshTickets();
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
      <header className="app-drag flex flex-wrap items-center gap-2 border-b px-3 py-3 sm:gap-3 sm:px-4">
        {/* This route is the window's leading edge, so Electron window controls sit in the header. */}
        {desktopBridge() ? <WindowChrome className={rail ? "md:hidden" : undefined} /> : null}
        <div className="flex min-w-fit flex-1 items-center gap-1">
          <IconTooltip label={t`Back`}>
            <Link
              to="/app"
              aria-label={t`Back`}
              className={buttonVariants({
                variant: "ghost",
                size: "icon",
                className: `app-no-drag text-muted-foreground ${rail ? "md:hidden" : ""}`,
              })}
            >
              <ChevronLeft />
            </Link>
          </IconTooltip>
          <h1 className="font-medium">
            <Trans>Board</Trans>
          </h1>
        </div>
        <OptionSelect
          aria-label={t`Board view`}
          className="app-no-drag w-auto max-w-full"
          value={view}
          onValueChange={(value) => {
            const next = new URLSearchParams(params);
            if (value === "table") next.set("view", "table");
            else next.delete("view");
            setParams(next, { replace: true });
          }}
          options={[
            { value: "kanban", label: t`Kanban` },
            { value: "table", label: t`Table` },
          ]}
        />
        <Button
          className="app-no-drag max-w-full whitespace-normal"
          onClick={() => setSelectedId("new")}
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
        {view === "table" ? (
          <TicketTable tickets={shownTickets} bots={bots} onOpen={setSelectedId} />
        ) : (
          <BoardColumns
            tickets={shownTickets}
            bots={bots}
            onOpen={setSelectedId}
            moving={change.pending}
            onMove={(id, status) => change.run({ id, status })}
          />
        )}
        {tickets.length === 0 && !error ? (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-body text-muted-foreground">
            <Trans>No tickets yet</Trans>
          </p>
        ) : null}
      </main>
      {creating || selected ? (
        <TicketDialog
          key={selectedId}
          ticket={selected ?? null}
          changing={change.pending}
          onChange={change.run}
          bots={bots}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}

function useTicketChange() {
  const queries = useSpaceQueries();
  const client = useQueryClient();
  const list = queries.tickets.list.queryOptions({ input: {} });
  return useSave({
    save: async (input: TicketChange, rpc) => {
      const before = client
        .getQueryData(list.queryKey)
        ?.tickets.find((ticket) => ticket.id === input.id);
      const saved = await rpc.tickets.update(input);
      // Publish the response only if the cached ticket still matches the one we edited.
      // A live read may have delivered a newer revision with the same timestamp.
      if (!before) return;
      client.setQueryData(list.queryKey, (current) => {
        if (!current?.tickets.includes(before)) return undefined;
        return { tickets: current.tickets.map((ticket) => (ticket === before ? saved : ticket)) };
      });
    },
    stale: [list.queryKey],
    onFailed: (error) => toast.error(errorText(error)),
  });
}

type TextDraft = { base: string; value: string };

function editText(draft: TextDraft | null, saved: string, value: string): TextDraft | null {
  const base = draft?.base ?? saved;
  return value === base || value === saved ? null : { base, value };
}

function TicketDialog({
  ticket,
  changing,
  onChange,
  bots,
  onClose,
}: {
  ticket: Ticket | null;
  changing: boolean;
  onChange: (input: TicketChange) => void;
  bots: Bot[];
  onClose: () => void;
}) {
  const { t } = useLingui();
  const formId = useId();
  const statuses = useTicketStatusLabels();
  const priorities = useTicketPriorityLabels();
  const [titleDraft, setTitle] = useState<TextDraft | null>(null);
  const [descriptionDraft, setDescription] = useState<TextDraft | null>(null);
  const [newOwner, setOwner] = useState(bots[0]?.id ?? "");
  const [newPriority, setPriority] = useState<TicketPriority>("normal");
  const savedTitle = ticket?.title ?? "";
  const savedDescription = ticket?.description ?? "";
  const title = titleDraft?.value ?? savedTitle;
  const description = descriptionDraft?.value ?? savedDescription;
  const owner = ticket ? ticket.assigneeBotId : newOwner;
  const priority = ticket?.priority ?? newPriority;
  const titleChanged = title !== savedTitle;
  const descriptionChanged = description !== savedDescription;
  const textChanged = titleChanged || descriptionChanged;
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
          ...(titleChanged ? { title } : {}),
          ...(descriptionChanged ? { description } : {}),
        });
      else
        await rpc.tickets.create({
          title,
          description,
          assigneeBotId: newOwner,
          priority: newPriority,
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
  const busy = changing || saving.pending || commenting.pending;
  const failure = saving.error ?? commenting.error;
  const shownError = failure
    ? errorText(failure)
    : commentsQuery.error
      ? errorText(commentsQuery.error)
      : "";

  function changeField(input: TicketChange) {
    if (busy) return;
    saving.reset();
    commenting.reset();
    onChange(input);
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
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !title.trim() || (ticket ? !textChanged : !owner)) return;
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
                onChange={(event) => {
                  const value = event.target.value;
                  setTitle((draft) => editText(draft, savedTitle, value));
                }}
                maxLength={TICKET_TITLE_MAX_LENGTH}
                disabled={saving.pending}
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
                onChange={(event) => {
                  const value = event.target.value;
                  setDescription((draft) => editText(draft, savedDescription, value));
                }}
                maxLength={TICKET_DESCRIPTION_MAX_LENGTH}
                disabled={saving.pending}
              />
            </Field>
            {ticket && textChanged ? (
              <div className="flex justify-end">
                <Button type="submit" disabled={busy || !title.trim()}>
                  <Trans>Save</Trans>
                </Button>
              </div>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`${formId}-owner`}>
                <Trans>Owner</Trans>
              </FieldLabel>
              <div className="flex items-center gap-2">
                <OptionSelect
                  id={`${formId}-owner`}
                  className="min-w-0 flex-1"
                  value={owner || null}
                  onValueChange={(value) => {
                    if (!ticket) setOwner(value);
                    else if (value !== ticket.assigneeBotId)
                      changeField({ id: ticket.id, assigneeBotId: value });
                  }}
                  disabled={busy}
                  required={!ticket}
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
                  value={ticket.status}
                  onValueChange={(status) => {
                    if (status !== ticket.status) changeField({ id: ticket.id, status });
                  }}
                  disabled={busy}
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
                onValueChange={(value) => {
                  if (!ticket) setPriority(value);
                  else if (value !== ticket.priority)
                    changeField({ id: ticket.id, priority: value });
                }}
                disabled={busy}
                options={TICKET_PRIORITIES.map((value) => ({ value, label: priorities[value] }))}
              />
            </Field>
            {!ticket ? (
              <div className="flex justify-end">
                <Button type="submit" disabled={busy || !title.trim() || !owner}>
                  <Trans>Create</Trans>
                </Button>
              </div>
            ) : null}
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
                if (busy || !body.trim()) return;
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
