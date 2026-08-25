import type { BoardItem, RunStatus, UpcomingRoutine } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import { BotAvatar } from "@rakazo/ui-web";
import { ChevronLeft } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LoadingState } from "../components/beautiful-ui/primitives";
import { rpc } from "../lib/rpc";

const POLL_MS = 8_000;

type Column = {
  key: string;
  label: string;
  dotColor: string;
  statuses: RunStatus[];
};

// Only what's in flight right now — these are naturally bounded since a run
// always resolves to a terminal state and drops off on its own. No completed/
// failed history here (that piles up forever); each bot's own chat already
// has it.
const COLUMNS: Column[] = [
  { key: "queued", label: "Queued", dotColor: "#6C6C70", statuses: ["queued", "leased"] },
  { key: "working", label: "Working", dotColor: "#3B82F6", statuses: ["running"] },
  {
    key: "needs-you",
    label: "Needs you",
    dotColor: "#E65707",
    statuses: ["waiting_input", "waiting_takeover"],
  },
];

export function BoardPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<BoardItem[] | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingRoutine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards against an older, slower poll response overwriting a newer one.
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const result = await rpc.board.list({});
      if (id !== requestId.current) return;
      setItems(result.items);
      setUpcoming(result.upcoming);
      setError(null);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof Error ? err.message : "Could not load the board");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load();
    }, POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const grouped = COLUMNS.map((column) => ({
    column,
    items: (items ?? []).filter((item) => column.statuses.includes(item.status)),
  }));

  return (
    <div className="flex h-full flex-col bg-[#050506]">
      <div className="flex shrink-0 items-center gap-3 border-b border-[#141416] px-5 py-4">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate("/app")}
          className="text-[#9A9AA0] hover:text-[#ECECEE]"
        >
          <ChevronLeft size={20} strokeWidth={1.8} />
        </button>
        <h1 className="text-[16px] font-medium text-[#F1F1F2]">Board</h1>
      </div>
      {error ? (
        <p role="alert" className="px-5 py-3 text-[13px] text-[#EF6461]">
          {error}
        </p>
      ) : null}
      {items === null || upcoming === null ? (
        <div className="grid flex-1 place-items-center">
          <LoadingState label="Loading board" />
        </div>
      ) : (
        <div className="flex flex-1 gap-4 overflow-x-auto px-5 py-4">
          {grouped.map(({ column, items: columnItems }) => (
            <BoardColumn
              key={column.key}
              label={column.label}
              dotColor={column.dotColor}
              count={columnItems.length}
            >
              {columnItems.length === 0 ? (
                <EmptyColumn />
              ) : (
                columnItems.map((item) => (
                  <BoardCard
                    key={item.id}
                    item={item}
                    onOpen={() => navigate(`/app/${item.botId}`)}
                  />
                ))
              )}
            </BoardColumn>
          ))}
          <BoardColumn label="Upcoming" dotColor="#9B5CF6" count={upcoming.length}>
            {upcoming.length === 0 ? (
              <EmptyColumn />
            ) : (
              upcoming.map((routine) => (
                <UpcomingCard
                  key={routine.id}
                  routine={routine}
                  onOpen={() => navigate(`/app/${routine.botId}?routine=${routine.id}`)}
                />
              ))
            )}
          </BoardColumn>
        </div>
      )}
    </div>
  );
}

function BoardColumn({
  label,
  dotColor,
  count,
  children,
}: {
  label: string;
  dotColor: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="flex w-[300px] shrink-0 flex-col">
      <div className="mb-3 flex shrink-0 items-center gap-2 px-1">
        <span
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: dotColor }}
          aria-hidden="true"
        />
        <span className="text-[13.5px] font-medium text-[#ECECEE]">{label}</span>
        <span className="text-[12.5px] text-[#6C6C70]">{count}</span>
      </div>
      <div className="rk-scroll flex-1 space-y-2 overflow-y-auto pb-4">{children}</div>
    </div>
  );
}

function EmptyColumn() {
  return (
    <div className="rounded-[11px] border border-dashed border-[#1E1E22] px-3 py-6 text-center text-[12.5px] text-[#55555A]">
      Nothing here
    </div>
  );
}

function BoardCard({ item, onOpen }: { item: BoardItem; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-2 rounded-[13px] border border-[#1E1E22] bg-[#0E0E10] p-3 text-start hover:border-[#2A2A2F]"
    >
      <div className="flex items-center gap-2">
        <BotAvatar color={item.botColor} size={22} status={item.status} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-[#ECECEE]">{item.botName}</span>
        {item.trigger === "routine" ? (
          <span className="shrink-0 text-[12px] text-[#E65707]" title="Routine">
            ◷
          </span>
        ) : null}
      </div>
      <p className="line-clamp-3 text-[13.5px] leading-[1.4] text-[#C9C9CE]">{item.prompt}</p>
      <span className="text-[11.5px] text-[#6C6C70]">{relativeTime(item.updatedAt)}</span>
    </button>
  );
}

function UpcomingCard({ routine, onOpen }: { routine: UpcomingRoutine; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-2 rounded-[13px] border border-[#1E1E22] bg-[#0E0E10] p-3 text-start hover:border-[#2A2A2F]"
    >
      <div className="flex items-center gap-2">
        <BotAvatar color={routine.botColor} size={22} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-[#ECECEE]">
          {routine.botName}
        </span>
        <span className="shrink-0 text-[12px] text-[#9B5CF6]" title="Routine">
          ◷
        </span>
      </div>
      <span className="truncate text-[13.5px] font-medium text-[#ECECEE]">{routine.name}</span>
      <p className="line-clamp-2 text-[12.5px] leading-[1.4] text-[#85858A]">
        {routine.crons.map(formatCron).join(" · ")}
      </p>
      <span className="text-[11.5px] text-[#9B5CF6]">
        {routine.nextRunAt ? countdown(routine.nextRunAt) : "not scheduled"}
      </span>
    </button>
  );
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const seconds = Math.max(0, Math.round(diffMs / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function countdown(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "due now";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}
