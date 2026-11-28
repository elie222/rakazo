import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Ticket, TicketPriority, TicketStatus } from "@rakazo/contracts";
import { isTicketCompletedStatus, TICKET_STATUSES } from "@rakazo/contracts";
import { Badge, Button } from "@rakazo/ui-web";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@rakazo/ui-web/components/ui/table";
import { Ellipsis } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useTicketPriorityLabels } from "./ticket-priority";
import { useTicketStatusLabels } from "./ticket-status";

const TICKET_DRAG_TYPE = "application/x-rakazo-ticket";

const badgeColors = {
  success: { surface: "bg-success/10", dot: "bg-success" },
  warning: { surface: "bg-warning/10", dot: "bg-warning" },
  destructive: { surface: "bg-destructive/10", dot: "bg-destructive" },
};

const statusTones: Partial<Record<TicketStatus, keyof typeof badgeColors>> = {
  blocked: "warning",
  done: "success",
};

const priorityTones: Partial<Record<TicketPriority, keyof typeof badgeColors>> = {
  high: "warning",
  urgent: "destructive",
};

function TicketBadge({ tone, children }: { tone?: keyof typeof badgeColors; children: ReactNode }) {
  const colors = tone ? badgeColors[tone] : undefined;
  return (
    <Badge variant="secondary" className={colors ? `${colors.surface} text-foreground` : undefined}>
      {colors ? <span aria-hidden className={`size-1.5 rounded-full ${colors.dot}`} /> : null}
      {children}
    </Badge>
  );
}

type TicketViewProps = {
  tickets: Ticket[];
  bots: Bot[];
  onOpen: (id: string) => void;
  changing: boolean;
  onArchive: (id: string, archived: boolean) => void;
};

function TicketActions({
  ticket,
  changing,
  onArchive,
}: Pick<TicketViewProps, "changing" | "onArchive"> & { ticket: Ticket }) {
  const { t } = useLingui();
  if (ticket.archivedAt === undefined) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={t`Actions for ${ticket.ref}`}
            disabled={changing}
          />
        }
      >
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onArchive(ticket.id, !ticket.archivedAt)}>
          {ticket.archivedAt ? <Trans>Restore ticket</Trans> : <Trans>Archive ticket</Trans>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BoardColumns({
  tickets,
  bots,
  onOpen,
  openOnly,
  changing,
  onArchive,
  onMove,
}: TicketViewProps & {
  openOnly: boolean;
  onMove: (id: string, status: TicketStatus) => void;
}) {
  const statuses = useTicketStatusLabels();
  const priorities = useTicketPriorityLabels();
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [destination, setDestination] = useState<TicketStatus | null>(null);
  const dragged = tickets.find((ticket) => ticket.id === draggedId);

  function finishDrag() {
    setDraggedId(null);
    setDestination(null);
  }

  return (
    <div data-testid="board-columns" className="flex min-h-full gap-3">
      {TICKET_STATUSES.filter((status) => !openOnly || !isTicketCompletedStatus(status)).map(
        (status) => {
          const canDrop = dragged && dragged.status !== status && !changing;
          return (
            <section
              key={status}
              aria-labelledby={`board-column-${status}`}
              className={`min-w-40 flex-1 space-y-2 rounded-lg ${canDrop && destination === status ? "bg-muted ring-1 ring-border" : ""}`}
              onDragOver={(event) => {
                if (!canDrop) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDestination(status);
              }}
              onDragLeave={(event) => {
                if (
                  !(event.relatedTarget instanceof Node) ||
                  !event.currentTarget.contains(event.relatedTarget)
                ) {
                  setDestination((current) => (current === status ? null : current));
                }
              }}
              onDrop={(event) => {
                if (!canDrop || event.dataTransfer.getData(TICKET_DRAG_TYPE) !== dragged.id) return;
                event.preventDefault();
                finishDrag();
                onMove(dragged.id, status);
              }}
            >
              <h2 id={`board-column-${status}`} className="flex px-1 py-1">
                <TicketBadge tone={statusTones[status]}>{statuses[status]}</TicketBadge>
              </h2>
              {tickets
                .filter((ticket) => ticket.status === status)
                .map((ticket) => (
                  <div key={ticket.id} className="relative">
                    <button
                      type="button"
                      data-testid={`board-card-${ticket.id}`}
                      className="flex w-full flex-col items-start gap-1 rounded-lg border bg-background p-3 text-left text-body hover:bg-muted enabled:cursor-grab focus-visible:outline-2 focus-visible:outline-ring"
                      draggable={!changing}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData(TICKET_DRAG_TYPE, ticket.id);
                        setDraggedId(ticket.id);
                      }}
                      onDragEnd={finishDrag}
                      onClick={() => onOpen(ticket.id)}
                    >
                      <span className="flex w-full flex-wrap items-center justify-between gap-x-2 gap-y-1 pr-6">
                        <span className="text-label text-muted-foreground">{ticket.ref}</span>
                        {ticket.priority !== "normal" ? (
                          <TicketBadge tone={priorityTones[ticket.priority]}>
                            {priorities[ticket.priority]}
                          </TicketBadge>
                        ) : null}
                      </span>
                      <span className="w-full wrap-break-word font-medium">{ticket.title}</span>
                      {ticket.assigneeBotId ? (
                        <span className="text-label text-muted-foreground">
                          {bots.find((bot) => bot.id === ticket.assigneeBotId)?.name}
                        </span>
                      ) : null}
                    </button>
                    <div className="absolute top-1 right-1">
                      <TicketActions ticket={ticket} changing={changing} onArchive={onArchive} />
                    </div>
                  </div>
                ))}
            </section>
          );
        },
      )}
    </div>
  );
}

export function TicketTable({ tickets, bots, onOpen, changing, onArchive }: TicketViewProps) {
  const statuses = useTicketStatusLabels();
  const priorities = useTicketPriorityLabels();

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table className="min-w-2xl table-fixed">
        <colgroup>
          <col className="w-[46%]" />
          <col className="w-[19%]" />
          <col className="w-[20%]" />
          <col className="w-[15%]" />
        </colgroup>
        <TableHeader className="bg-muted/60">
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="px-4 text-label text-muted-foreground">
              <Trans>Ticket</Trans>
            </TableHead>
            <TableHead scope="col" className="px-4 text-label text-muted-foreground">
              <Trans>Status</Trans>
            </TableHead>
            <TableHead scope="col" className="px-4 text-label text-muted-foreground">
              <Trans>Owner</Trans>
            </TableHead>
            <TableHead scope="col" className="px-4 text-label text-muted-foreground">
              <Trans>Priority</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tickets.map((ticket) => (
            <TableRow key={ticket.id} className="focus-within:bg-muted/50">
              <TableCell className="px-4 py-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start px-0 hover:bg-transparent"
                  onClick={() => onOpen(ticket.id)}
                >
                  <span className="shrink-0 text-label font-normal text-muted-foreground">
                    {ticket.ref}
                  </span>
                  <span className="truncate">{ticket.title}</span>
                </Button>
              </TableCell>
              <TableCell className="px-4 py-1.5">
                <TicketBadge tone={statusTones[ticket.status]}>
                  {statuses[ticket.status]}
                </TicketBadge>
              </TableCell>
              <TableCell className="truncate px-4 py-1.5 text-muted-foreground">
                {bots.find((bot) => bot.id === ticket.assigneeBotId)?.name ?? "—"}
              </TableCell>
              <TableCell className="px-4 py-1.5">
                <div className="flex items-center justify-between gap-1">
                  <TicketBadge tone={priorityTones[ticket.priority]}>
                    {priorities[ticket.priority]}
                  </TicketBadge>
                  <TicketActions ticket={ticket} changing={changing} onArchive={onArchive} />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
