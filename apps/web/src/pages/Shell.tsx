import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type {
  Bot,
  ComputerStatus,
  ProductEvent,
  Routine,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import {
  abortableDelay,
  cronFromPreset,
  defaultCronPreset,
  formatCron,
  presetFromCron,
} from "@rakazo/core";
import { BotAvatar, Button } from "@rakazo/ui-web";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { authClient } from "../lib/auth";
import { rpc } from "../lib/rpc";
import {
  isComputerStatusEvent,
  mergeThreadSnapshot,
  prependThreadMessagePage,
  reduceComputerStatus,
  reduceThreadSnapshot,
} from "../lib/thread-events";
import { BotContextMenu, type ContextMenuPosition } from "./BotContextMenu";
import { HostComputerPrompt } from "./HostComputerPrompt";
import { PluginsOverlay } from "./PluginsOverlay";
import { RoutineSchedule } from "./RoutineSchedule";
import { WindowChrome } from "./WindowChrome";

type Panel = "computer" | "settings" | "routine" | "create" | null;

export function ShellPage() {
  const { botId } = useParams();
  const navigate = useNavigate();
  const session = authClient.useSession();
  const [bots, setBots] = useState<Bot[]>([]);
  const [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [botMenu, setBotMenu] = useState<{
    botId: string;
    position: ContextMenuPosition;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [booting, setBooting] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [routineDraft, setRoutineDraft] = useState({
    name: "",
    prompt: "",
    schedule: defaultCronPreset(),
  });
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);
  const [usage, setUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
    runs: number;
  } | null>(null);
  const autoBooted = useRef<string | null>(null);
  const expandedHistoryThread = useRef<string | null>(null);
  const messageScroll = useRef<HTMLDivElement>(null);
  const manuallyUnread = useRef(new Set<string>());
  const computerVisible = useRef(false);
  computerVisible.current = panel === "computer" || computerOpen;

  const active = bots.find((b) => b.id === botId) ?? bots[0];
  const activeBotId = useRef<string | undefined>(active?.id);
  activeBotId.current = active?.id;
  const screenRequest = useRef(0);
  const contextBot = botMenu ? bots.find((bot) => bot.id === botMenu.botId) : undefined;
  const closeBotMenu = useCallback(() => setBotMenu(null), []);
  const updateBotUnread = useCallback((id: string, unread: boolean) => {
    setBots((current) => {
      const bot = current.find((candidate) => candidate.id === id);
      if (!bot || bot.unread === unread) return current;
      return current.map((candidate) =>
        candidate.id === id ? { ...candidate, unread } : candidate,
      );
    });
  }, []);
  const markBotRead = useCallback(
    async (id: string) => {
      await rpc.threads.markRead({ botId: id });
      manuallyUnread.current.delete(id);
      updateBotUnread(id, false);
    },
    [updateBotUnread],
  );
  const markBotUnread = useCallback(
    async (id: string) => {
      manuallyUnread.current.add(id);
      try {
        await rpc.threads.markUnread({ botId: id });
      } catch (err) {
        manuallyUnread.current.delete(id);
        throw err;
      }
      updateBotUnread(id, true);
    },
    [updateBotUnread],
  );
  // A bot the user marked unread by hand stays unread until they open it again,
  // otherwise the auto-read below would undo the action on the next window focus.
  const markBotReadIfVisible = useCallback(
    (id: string) => {
      if (manuallyUnread.current.has(id)) return;
      if (document.visibilityState === "visible" && document.hasFocus()) {
        void markBotRead(id).catch(() => undefined);
      }
    },
    [markBotRead],
  );

  async function refreshBots() {
    const list = await rpc.bots.list();
    setBots(list);
    if (list.length === 0) {
      navigate("/onboarding", { replace: true });
      return;
    }
    if (!botId || !list.some((bot) => bot.id === botId)) {
      navigate(`/app/${list[0]!.id}`, { replace: true });
    }
  }

  async function refreshThread(id: string) {
    const scrollElement = messageScroll.current;
    const stickToEnd =
      !scrollElement ||
      scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < 80;
    const snap = await rpc.threads.get({ botId: id });
    setSnapshot((prev) =>
      mergeThreadSnapshot(prev, snap, expandedHistoryThread.current === snap.threadId),
    );
    setComputer(snap.computer);
    const routines = await rpc.routines.list({ botId: id });
    setRoutines(routines);
    await refreshComputerScreen(id);
    if (stickToEnd) {
      window.requestAnimationFrame(() => {
        const element = messageScroll.current;
        if (element) element.scrollTop = element.scrollHeight;
      });
    }
    return snap;
  }

  async function refreshComputerScreen(id: string) {
    if (!computerVisible.current) return;
    const request = ++screenRequest.current;
    const screen = await rpc.computer.screenUrl({ botId: id }).catch(() => ({ url: null }));
    if (
      request !== screenRequest.current ||
      activeBotId.current !== id ||
      !computerVisible.current
    ) {
      return;
    }
    setScreenUrl(screen.url);
  }

  async function loadOlderMessages() {
    if (!active || snapshot?.olderCursor == null || loadingOlder) return;
    const scrollElement = messageScroll.current;
    const previousHeight = scrollElement?.scrollHeight ?? 0;
    setLoadingOlder(true);
    try {
      const page = await rpc.threads.messages({
        botId: active.id,
        before: snapshot.olderCursor,
      });
      expandedHistoryThread.current = page.threadId;
      setSnapshot((prev) => prependThreadMessagePage(prev, page));
      window.requestAnimationFrame(() => {
        const element = messageScroll.current;
        if (element) element.scrollTop += element.scrollHeight - previousHeight;
      });
    } finally {
      setLoadingOlder(false);
    }
  }

  useEffect(() => {
    void refreshBots();
    const poll = window.setInterval(() => void refreshBots().catch(() => undefined), 4000);
    return () => window.clearInterval(poll);
  }, []);

  useEffect(() => {
    if (!active) return;
    // Opening a bot clears the manual unread flag so it can auto-read again.
    manuallyUnread.current.delete(active.id);
    const markVisibleBotRead = () => {
      markBotReadIfVisible(active.id);
    };
    markVisibleBotRead();
    window.addEventListener("focus", markVisibleBotRead);
    document.addEventListener("visibilitychange", markVisibleBotRead);
    return () => {
      window.removeEventListener("focus", markVisibleBotRead);
      document.removeEventListener("visibilitychange", markVisibleBotRead);
    };
  }, [active?.id, markBotReadIfVisible]);

  useEffect(() => {
    if (!active) return;
    screenRequest.current += 1;
    setScreenUrl(null);
    expandedHistoryThread.current = null;
    const abort = new AbortController();
    void (async () => {
      const snap = await refreshThread(active.id).catch(() => null);
      if (abort.signal.aborted) return;
      let cursor = snap?.cursor ?? -1;
      let retryMs = 250;
      while (!abort.signal.aborted) {
        try {
          const events = await rpc.threads.subscribe(
            { botId: active.id, cursor },
            { signal: abort.signal },
          );
          for await (const event of events) {
            if (abort.signal.aborted) break;
            cursor = Math.max(cursor, event.seq);
            retryMs = 250;
            applyThreadEvent(event, setSnapshot, setComputer);
            if (
              event.type === "bot.spawned" ||
              event.type === "bot.deleted" ||
              event.type === "run.completed"
            ) {
              void refreshBots().catch(() => undefined);
            }
            if (event.type === "thread.message.created") {
              const blocks = (event.payload.blocks as Array<{ kind?: string }>) ?? [];
              if (blocks.some((block) => block.kind === "child_bot")) {
                void refreshBots().catch(() => undefined);
              }
              if (event.payload.role === "bot") markBotReadIfVisible(active.id);
            }
            if (event.type === "run.completed") {
              void refreshThread(active.id).catch(() => undefined);
            } else if (isComputerStatusEvent(event)) {
              void refreshComputerScreen(active.id).catch(() => undefined);
            }
          }
        } catch {
          // The durable cursor below makes reconnects safe after a transient network failure.
        }
        if (abort.signal.aborted) break;
        await refreshThread(active.id).catch(() => null);
        await abortableDelay(retryMs, abort.signal);
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    })();
    return () => {
      abort.abort();
    };
  }, [active?.id, markBotReadIfVisible]);

  const filtered = useMemo(
    () => bots.filter((b) => `${b.name} ${b.preview}`.toLowerCase().includes(query.toLowerCase())),
    [bots, query],
  );

  async function send() {
    if (!active || !draft.trim()) return;
    const text = draft;
    setDraft("");
    await rpc.threads.send({ botId: active.id, text });
    await refreshThread(active.id);
  }

  async function createBot(input: { name: string; title: string; description: string }) {
    const bot = await rpc.bots.create({
      name: input.name.trim(),
      title: input.title,
      description: input.description,
      instructions: input.description,
      notifyOnFinish: true,
    });
    await refreshBots();
    navigate(`/app/${bot.id}`);
    setPanel(null);
  }

  async function bootComputer({
    takeControl,
    overlay,
    force = false,
  }: {
    takeControl: boolean;
    overlay: boolean;
    force?: boolean;
  }) {
    if (!active) return;
    const needsBoot = force || computer?.state !== "running" || !screenUrl;
    if (overlay && needsBoot) setBooting(true);
    try {
      if (needsBoot) await rpc.computer.boot({ botId: active.id });
      if (takeControl) await rpc.computer.takeover({ botId: active.id });
      await refreshThread(active.id);
    } finally {
      setBooting(false);
    }
  }

  useEffect(() => {
    if (panel !== "computer") {
      autoBooted.current = null;
      return;
    }
    if (!active) return;
    if (computer?.state === "booting" || computer?.state === "suspended") return;
    if (autoBooted.current === active.id && computer?.state === "running" && screenUrl) return;
    autoBooted.current = active.id;
    void bootComputer({
      takeControl: false,
      overlay: computer?.state !== "running",
      force: true,
    });
  }, [panel, active?.id, computer?.state, screenUrl]);

  useEffect(() => {
    setComputerOpen(false);
  }, [active?.id]);

  useEffect(() => {
    if (!computerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setComputerOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [computerOpen]);

  useEffect(() => {
    if ((panel !== "computer" && !computerOpen) || !active || computer?.state !== "running") return;
    const ping = () => void rpc.computer.heartbeat({ botId: active.id }).catch(() => undefined);
    ping();
    const timer = window.setInterval(ping, 60_000);
    return () => window.clearInterval(timer);
  }, [panel, computerOpen, active?.id, computer?.state]);

  async function openComputer() {
    if (!active) return;
    const needsTakeover = computer?.controlHolder !== "user";
    await bootComputer({
      takeControl: needsTakeover,
      overlay: needsTakeover || computer?.state !== "running",
      force: computer?.state !== "running",
    });
    setComputerOpen(true);
  }

  async function releaseComputer() {
    if (!active) return;
    setComputerOpen(false);
    await rpc.computer.release({ botId: active.id }).catch(() => undefined);
    await refreshThread(active.id);
  }

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl);

  const userName = session.data?.user.name ?? "You";
  const initials = userName
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="relative flex h-full min-w-0 overflow-hidden bg-[#050506] text-[#DFDFE2]">
      <HostComputerPrompt />
      <aside className="flex w-[316px] shrink-0 flex-col border-r border-[#171719] bg-[#0B0B0C]">
        <div className="app-drag flex items-center justify-between px-[18px] pb-3 pt-4">
          <WindowChrome />
          <button
            type="button"
            onClick={() => setPanel("create")}
            className="app-no-drag text-[21px] text-[#7A7A80] hover:text-[#C9C9CE]"
            title="New bot"
          >
            +
          </button>
        </div>
        <div className="mx-3.5 mb-3 flex items-center gap-2.5 rounded-xl border border-[#202023] bg-[#141416] px-3 py-2 text-[14px] text-[#6C6C70]">
          <span>⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="w-full bg-transparent outline-none"
          />
        </div>
        <div className="rk-scroll flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2.5">
          {filtered.map((bot) => (
            <button
              key={bot.id}
              type="button"
              onClick={() => navigate(`/app/${bot.id}`)}
              onContextMenu={(event) => {
                event.preventDefault();
                setBotMenu({ botId: bot.id, position: { x: event.clientX, y: event.clientY } });
              }}
              className="flex gap-3 rounded-xl px-2.5 py-[11px] text-left"
              style={{
                background: active?.id === bot.id ? "#161618" : "transparent",
              }}
            >
              <BotAvatar color={bot.color} size={38} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={`text-[15px] text-[#ECECEE] ${
                      bot.unread ? "font-semibold" : "font-medium"
                    }`}
                  >
                    {bot.name}
                    {bot.unread ? <span className="sr-only"> (unread)</span> : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-[#6C6C70]">
                    {bot.status === "idle" ? "" : bot.status}
                    {bot.unread ? (
                      <span
                        aria-hidden="true"
                        className="inline-block h-2 w-2 rounded-full bg-[#8B5CF6]"
                      />
                    ) : null}
                  </span>
                </div>
                <div
                  className={`mt-0.5 truncate text-[13.5px] ${
                    bot.unread ? "font-medium text-[#C9C9CE]" : "text-[#85858A]"
                  }`}
                >
                  {bot.preview || bot.title}
                </div>
              </div>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setPluginsOpen(true)}
          className="mx-3 mb-1 flex items-center gap-3 rounded-[11px] px-2.5 py-2 hover:bg-[#131315]"
        >
          <span className="grid h-[30px] w-[30px] place-items-center rounded-full bg-[#17171A] text-[#9A9AA0]">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 7h3a1 1 0 0 0 1-1 1.5 1.5 0 1 1 3 0 1 1 0 0 0 1 1h3v3a1 1 0 0 0 1 1 1.5 1.5 0 1 1 0 3 1 1 0 0 0-1 1v3h-3a1 1 0 0 0-1 1 1.5 1.5 0 1 1-3 0 1 1 0 0 0-1-1H4v-3a1 1 0 0 0-1-1 1.5 1.5 0 1 1 0-3 1 1 0 0 0 1-1z" />
            </svg>
          </span>
          <span className="text-[14.5px] text-[#C9C9CE]">Plugins</span>
        </button>
        <div className="relative">
          {menuOpen ? (
            <div className="absolute bottom-14 left-3 right-3 rounded-2xl border border-[#2A2A2F] bg-[#1A1A1D] p-2 shadow-[0_22px_50px_rgba(0,0,0,.55)]">
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 hover:bg-[#232327]"
                onClick={async () => {
                  setUsage(await rpc.usage.summary());
                }}
              >
                <span className="text-[#9A9AA0]">◔</span>
                <span className="flex-1 text-left text-[14.5px] text-[#ECECEE]">Weekly usage</span>
              </button>
              {usage ? (
                <p className="px-3 pb-2 text-[12.5px] text-[#85858A]">
                  {usage.runs} runs · {usage.inputTokens + usage.outputTokens} tokens
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => void authClient.signOut().then(() => navigate("/"))}
                className="flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 hover:bg-[#232327]"
              >
                <span className="text-[#9A9AA0]">⇤</span>
                <span className="text-[14.5px] text-[#ECECEE]">Log out</span>
              </button>
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-[11px] px-[18px] py-3.5"
          >
            <span className="grid h-8 w-8 place-items-center rounded-full bg-[#232326] text-[12px] text-[#A8A8AD]">
              {initials}
            </span>
            <span className="text-[14.5px] text-[#C9C9CE]">{userName}</span>
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-[#0D0D0E]">
        <div className="flex items-center justify-between border-b border-[#141416] px-[22px] py-[17px]">
          <button
            type="button"
            onClick={() => setPanel("settings")}
            className="flex min-w-0 items-center gap-3"
          >
            {active ? <BotAvatar color={active.color} size={26} /> : null}
            <span className="min-w-0">
              <span className="block truncate text-[16px] font-medium text-[#ECECEE]">
                {active?.name ?? "Select a bot"}
              </span>
            </span>
          </button>
          <button
            type="button"
            title="Agent computer"
            onClick={() => setPanel((p) => (p === "computer" ? null : "computer"))}
            className="grid h-[30px] w-[34px] place-items-center rounded-[9px] hover:bg-[#1B1B1E]"
            style={{ background: panel ? "#1B1B1E" : "transparent" }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#A8A8AD"
              strokeWidth="1.6"
            >
              <rect x="2" y="4" width="20" height="13" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          </button>
        </div>
        <div
          ref={messageScroll}
          className="rk-scroll flex flex-1 flex-col gap-[13px] overflow-y-auto px-7 py-6"
        >
          {snapshot?.olderCursor != null ? (
            <button
              type="button"
              disabled={loadingOlder}
              onClick={() => void loadOlderMessages()}
              className="self-center rounded-lg px-3 py-1.5 text-[13px] text-[#85858A] hover:bg-[#1A1A1D] hover:text-[#C9C9CE] disabled:opacity-50"
            >
              {loadingOlder ? "Loading…" : "Load earlier messages"}
            </button>
          ) : null}
          {(snapshot?.messages ?? []).map((message) => (
            <MessageView
              key={message.id}
              message={message}
              onOpenBot={(id) => navigate(`/app/${id}`)}
              onAnswer={(text) =>
                active &&
                rpc.threads.answer({ botId: active.id, runId: message.runId ?? "", answer: text })
              }
            />
          ))}
          {snapshot?.run && ["running", "queued", "leased"].includes(snapshot.run.status) ? (
            <div className="flex justify-start">
              <div
                className="rounded-[20px] bg-[#1A1A1D] px-[18px] py-[13px] text-[14.5px] text-[#85858A]"
                style={{ animation: "rkPulse 1.2s ease-in-out infinite" }}
              >
                working…
              </div>
            </div>
          ) : null}
        </div>
        <div className="px-6 pb-6 pt-3">
          <div className="flex items-center gap-3.5 rounded-full border border-[#202023] bg-[#131315] py-[9px] pr-2.5 pl-3">
            <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full border border-[#26262A] text-[18px] text-[#9A9AA0]">
              +
            </span>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={active ? `Message ${active.name}` : "Message…"}
              className="flex-1 bg-transparent text-[15.5px] text-[#E9E9EA] outline-none"
            />
            {snapshot?.run && ["running", "queued", "leased"].includes(snapshot.run.status) ? (
              <button
                type="button"
                aria-label="Stop"
                onClick={() =>
                  active &&
                  void rpc.threads.stop({ botId: active.id }).then(() => refreshThread(active.id))
                }
                className="grid h-9 w-9 place-items-center rounded-full bg-[#F1F1EF] text-[#17171A]"
              >
                ■
              </button>
            ) : (
              <button
                type="button"
                aria-label="Send"
                onClick={() => void send()}
                className="grid h-9 w-9 place-items-center rounded-full bg-[#F1F1EF] text-[#17171A]"
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </main>

      <aside
        className={`flex h-full min-h-0 shrink-0 flex-col overflow-hidden bg-[#0A0A0B] transition-[width] duration-200 ease-out ${
          panel && active ? "w-[384px] border-l border-[#141416]" : "w-0"
        }`}
      >
        {panel && active ? (
          <div className="rk-scroll h-full w-[384px] overflow-y-auto px-5 py-[17px]">
            {panel !== "routine" && panel !== "create" ? (
              <div className="mb-4 flex items-center justify-between">
                <span className="text-[13.5px] text-[#85858A]">
                  {computer?.state ?? active.status}
                </span>
                <div className="flex gap-3.5">
                  <button type="button" onClick={() => setPanel("settings")}>
                    ⚙
                  </button>
                  <button type="button" onClick={() => setPanel(null)}>
                    ✕
                  </button>
                </div>
              </div>
            ) : null}
            {panel === "computer" ? (
              <div>
                <div className="relative aspect-[16/10] overflow-hidden rounded-[14px] bg-[#0E0E10]">
                  {computerOpen ? (
                    <div className="grid h-full place-items-center text-sm text-[#6C6C70]">
                      Open in full window
                    </div>
                  ) : computer?.kind === "desktop" ? (
                    <div className="grid h-full place-items-center px-6 text-center text-sm text-[#6C6C70]">
                      This bot runs on this computer, not a Linux desktop. Shell and files use your
                      home folder.
                    </div>
                  ) : computer?.state === "running" && embeddedScreenUrl ? (
                    <iframe
                      title="Bot screen preview"
                      src={embeddedScreenUrl}
                      sandbox={screenIframeSandbox(embeddedScreenUrl)}
                      className="h-full w-full border-0 bg-black"
                      allow="clipboard-read; clipboard-write"
                      style={{ pointerEvents: "none" }}
                    />
                  ) : (
                    <div className="grid h-full place-items-center text-sm text-[#6C6C70]">
                      {computerPlaceholder(computer?.state, booting, active.name)}
                    </div>
                  )}
                  <button
                    type="button"
                    className="absolute inset-0 cursor-pointer"
                    aria-label="Open computer"
                    onClick={() => void openComputer()}
                  />
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-[13.5px] text-[#85858A]">
                    {computer?.controlHolder === "user"
                      ? "You have control"
                      : computer?.state === "suspended"
                        ? "Asleep"
                        : `${active.name}’s screen`}
                  </span>
                  {computer?.controlHolder === "user" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void releaseComputer()}
                    >
                      Release
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void openComputer()}
                    >
                      Take control
                    </Button>
                  )}
                </div>
                <div className="mt-[30px] mb-3 text-[14px] text-[#85858A]">Routines</div>
                {routines.map((routine) => (
                  <button
                    key={routine.id}
                    type="button"
                    onClick={() => {
                      setRoutineDraft({
                        name: routine.name,
                        prompt: routine.prompt,
                        schedule: presetFromCron(routine.cron),
                      });
                      setPanel("routine");
                    }}
                    className="flex w-full items-center gap-3 rounded-[11px] px-2.5 py-2.5 hover:bg-[#121214]"
                  >
                    <span className="text-[#E65707]">◷</span>
                    <span className="flex-1 text-left text-[14.5px] text-[#ECECEE]">
                      {routine.name}
                    </span>
                    <span className="text-[13px] text-[#6C6C70]">{formatCron(routine.cron)}</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={async () => {
                    const first = routines[0];
                    if (first) {
                      await rpc.routines.testRun({ routineId: first.id });
                      await refreshThread(active.id);
                    } else {
                      setRoutineDraft({ name: "", prompt: "", schedule: defaultCronPreset() });
                      setPanel("routine");
                    }
                  }}
                  className="mt-1 flex items-center gap-2.5 px-2.5 py-2.5 text-[14.5px] text-[#7A7A80]"
                >
                  Run now
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRoutineDraft({ name: "", prompt: "", schedule: defaultCronPreset() });
                    setPanel("routine");
                  }}
                  className="mt-1 flex items-center gap-2.5 px-2.5 py-2.5 text-[14.5px] text-[#7A7A80]"
                >
                  + New routine
                </button>
              </div>
            ) : null}
            {panel === "create" ? (
              <CreateBotForm
                onCancel={() => setPanel(null)}
                onCreate={(input) => void createBot(input)}
              />
            ) : null}
            {panel === "settings" ? (
              <BotSettings
                key={active.id}
                bot={active}
                onSave={async (patch) => {
                  await rpc.bots.update({ botId: active.id, ...patch });
                  await refreshBots();
                }}
                onExport={async () => {
                  const manifest = await rpc.export.bot({ botId: active.id });
                  const blob = new Blob([JSON.stringify(manifest, null, 2)], {
                    type: "application/json",
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${active.name.toLowerCase().replace(/\s+/g, "-")}-export.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                onDelete={async () => {
                  await rpc.bots.remove({ botId: active.id });
                  setPanel(null);
                  await refreshBots();
                }}
              />
            ) : null}
            {panel === "routine" ? (
              <div>
                <div className="mb-5 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setPanel("computer")}
                    className="text-[#9A9AA0]"
                  >
                    ‹
                  </button>
                  <div className="text-[15.5px] font-medium text-[#F1F1F2]">Routine</div>
                  <button type="button" onClick={() => setPanel(null)} className="text-[#6C6C70]">
                    ✕
                  </button>
                </div>
                <label className="text-[14px] text-[#85858A]">
                  Name
                  <input
                    value={routineDraft.name}
                    onChange={(e) => setRoutineDraft((s) => ({ ...s, name: e.target.value }))}
                    className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
                  />
                </label>
                <label className="mt-5 block text-[14px] text-[#85858A]">
                  Instruction
                  <textarea
                    value={routineDraft.prompt}
                    onChange={(e) => setRoutineDraft((s) => ({ ...s, prompt: e.target.value }))}
                    rows={4}
                    className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
                  />
                </label>
                <div className="mt-5 text-[14px] text-[#85858A]">
                  When to run
                  <RoutineSchedule
                    value={routineDraft.schedule}
                    onChange={(schedule) => setRoutineDraft((s) => ({ ...s, schedule }))}
                  />
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    await rpc.routines.create({
                      botId: active.id,
                      name: routineDraft.name || "Routine",
                      prompt: routineDraft.prompt || "Check in.",
                      cron: cronFromPreset(routineDraft.schedule),
                      timezone: "UTC",
                      active: true,
                      notify: true,
                    });
                    await refreshThread(active.id);
                    setPanel("computer");
                  }}
                  className="mt-5 rounded-[11px] bg-[#F1F1EF] px-4 py-2 text-[#17171A]"
                >
                  Save
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </aside>

      {contextBot && botMenu ? (
        <BotContextMenu
          bot={contextBot}
          position={botMenu.position}
          onClose={closeBotMenu}
          onTogglePinned={() => {
            setBotMenu(null);
            void rpc.bots
              .update({ botId: contextBot.id, pinned: !contextBot.pinned })
              .then(() => refreshBots());
          }}
          onToggleUnread={() => {
            const unread = !contextBot.unread;
            setBotMenu(null);
            const request = unread ? markBotUnread(contextBot.id) : markBotRead(contextBot.id);
            void request.catch(() => undefined);
          }}
          onEdit={() => {
            navigate(`/app/${contextBot.id}`);
            setPanel("settings");
            setBotMenu(null);
          }}
          onDuplicate={() => {
            setBotMenu(null);
            void rpc.bots.duplicate({ botId: contextBot.id }).then(async (bot) => {
              await refreshBots();
              navigate(`/app/${bot.id}`);
            });
          }}
          onDelete={() => {
            setDeleteTarget(contextBot);
            setBotMenu(null);
          }}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteBotDialog
          bot={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => {
            await rpc.bots.remove({ botId: deleteTarget.id });
            setDeleteTarget(null);
            setPanel(null);
            await refreshBots();
          }}
        />
      ) : null}

      {pluginsOpen ? <PluginsOverlay onClose={() => setPluginsOpen(false)} /> : null}

      {booting ? (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-[22px] bg-[rgba(4,4,5,.96)]">
          <div className="text-[19px] font-medium text-[#F1F1F2]">
            Booting up {active?.name}’s computer
          </div>
          <div className="h-[5px] w-[min(420px,70%)] overflow-hidden rounded-full bg-[#232327]">
            <div className="h-full w-2/3 rounded-full bg-[#F1F1EF]" />
          </div>
        </div>
      ) : computerOpen && active ? (
        <div className="absolute inset-0 z-30 flex flex-col bg-[#050506]">
          <div className="flex items-center justify-between gap-4 border-b border-[#171719] px-[18px] py-3.5">
            <div className="flex min-w-0 items-center gap-3">
              <BotAvatar color={active.color} size={28} />
              <span className="truncate text-[15.5px] font-medium text-[#ECECEE]">
                {active.name}’s computer
              </span>
              {computer?.controlHolder === "user" ? (
                <span className="rounded-full bg-[rgba(48,162,75,.14)] px-[11px] py-1 text-[13px] text-[#4ECB71]">
                  You have control
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              {computer?.controlHolder === "user" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void releaseComputer()}
                >
                  Release
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void bootComputer({ takeControl: true, overlay: false })}
                >
                  Take control
                </Button>
              )}
              <button
                type="button"
                className="text-[16px] text-[#85858A] hover:text-[#ECECEE]"
                aria-label="Close computer"
                onClick={() => setComputerOpen(false)}
              >
                ✕
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 bg-[#0E0E10]">
            {computer?.kind === "desktop" ? (
              <div className="grid h-full place-items-center px-8 text-center text-sm text-[#6C6C70]">
                This bot runs on this computer. There is no separate Linux desktop. Ask it to use
                the shell; working directories under your home folder are allowed.
              </div>
            ) : computer?.state === "running" && embeddedScreenUrl ? (
              <iframe
                title="Bot screen"
                src={embeddedScreenUrl}
                sandbox={screenIframeSandbox(embeddedScreenUrl)}
                className="h-full w-full border-0 bg-black"
                allow="clipboard-read; clipboard-write; fullscreen"
                style={{ pointerEvents: computer?.controlHolder === "user" ? "auto" : "none" }}
              />
            ) : (
              <div className="grid h-full place-items-center text-sm text-[#6C6C70]">
                {computer?.state === "suspended" ? "Computer is asleep" : `${active.name}’s screen`}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function applyThreadEvent(
  event: ProductEvent,
  setSnapshot: Dispatch<SetStateAction<ThreadSnapshot | null>>,
  setComputer: Dispatch<SetStateAction<ComputerStatus | null>>,
) {
  if (
    event.type === "thread.progress" ||
    event.type === "thread.subagent" ||
    event.type === "thread.message.created"
  ) {
    setSnapshot((prev) => reduceThreadSnapshot(prev, event));
  }
  if (isComputerStatusEvent(event)) {
    setComputer((prev) => reduceComputerStatus(prev, event));
  }
}

function MessageView({
  message,
  onAnswer,
  onOpenBot,
}: {
  message: ThreadMessage;
  onAnswer: (text: string) => void;
  onOpenBot: (botId: string) => void;
}) {
  return (
    <>
      {message.blocks.map((block, i) => {
        if (block.kind === "meta") {
          return (
            <div
              key={i}
              className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-[#85858A]"
            >
              <span className="text-[#E65707]">◷</span>
              <span>{block.text}</span>
            </div>
          );
        }
        if (block.kind === "progress") {
          return (
            <div key={i} className="flex justify-start">
              <div className="max-w-[74%] rounded-[20px] bg-[#1A1A1D] px-[18px] py-3 text-[15.5px] leading-[1.5] text-[#DFDFE2]">
                <ChatMarkdown streaming>{block.text}</ChatMarkdown>
              </div>
            </div>
          );
        }
        if (block.kind === "subagent") {
          const running = block.status === "running";
          const failed = block.status === "failed";
          return (
            <div
              key={i}
              className="w-[min(420px,90%)] rounded-[18px] border border-[#232326] bg-[#17171A] px-[18px] py-4"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[15px] font-medium text-[#ECECEE]">{block.name}</span>
                <span
                  className="rounded-full px-[11px] py-1 text-[13px]"
                  style={{
                    background: failed
                      ? "rgba(230,87,7,.14)"
                      : running
                        ? "rgba(245,160,60,.14)"
                        : "rgba(48,162,75,.14)",
                    color: failed ? "#E65707" : running ? "#F5A03C" : "#4ECB71",
                    animation: running ? "rkPulse 1.2s ease-in-out infinite" : undefined,
                  }}
                >
                  {running ? "subagent" : block.status}
                </span>
              </div>
              <div className="mt-2 text-[13.5px] text-[#85858A]">{block.task}</div>
              {block.progress || block.result ? (
                <div className="mt-2.5 text-[14.5px] leading-[1.5] text-[#A8A8AD]">
                  <ChatMarkdown streaming={running}>
                    {block.result || block.progress || ""}
                  </ChatMarkdown>
                </div>
              ) : null}
            </div>
          );
        }
        if (block.kind === "child_bot") {
          const deleted = block.status === "deleted";
          return (
            <button
              key={i}
              type="button"
              disabled={deleted}
              onClick={() => onOpenBot(block.botId)}
              className="w-[min(340px,90%)] rounded-[18px] border border-[#232326] bg-[#17171A] px-[18px] py-4 text-left disabled:opacity-60"
            >
              <div className="flex items-center justify-between">
                <span className="text-[15px] font-medium text-[#ECECEE]">{block.name}</span>
                <span
                  className="rounded-full px-[11px] py-1 text-[13px]"
                  style={{
                    background: deleted ? "rgba(230,87,7,.14)" : "rgba(48,162,75,.14)",
                    color: deleted ? "#E65707" : "#4ECB71",
                  }}
                >
                  {deleted ? "deleted" : "bot"}
                </span>
              </div>
              <div className="mt-2 text-[14.5px] leading-[1.5] text-[#A8A8AD]">
                {deleted
                  ? "Removed this bot, including its chat, computer, and memory."
                  : block.title || "Opened its own thread. Tap to switch."}
              </div>
            </button>
          );
        }
        if (block.kind === "text" && message.role === "user") {
          return (
            <div key={i} className="flex justify-end">
              <div className="max-w-[70%] rounded-[20px] bg-[#F1F1EF] px-[18px] py-3 text-[15.5px] leading-[1.45] text-[#1A1A1A]">
                {block.text}
              </div>
            </div>
          );
        }
        if (block.kind === "text") {
          return (
            <div key={i} className="flex justify-start">
              <div className="max-w-[74%] rounded-[20px] bg-[#1A1A1D] px-[18px] py-3 text-[15.5px] leading-[1.5] text-[#DFDFE2]">
                <ChatMarkdown>{block.text}</ChatMarkdown>
              </div>
            </div>
          );
        }
        if (block.kind === "card") {
          return (
            <div key={i} className="flex justify-start">
              <div className="flex flex-col gap-2 rounded-[20px] bg-[#1A1A1D] px-5 py-4">
                {block.lines.map((line) => (
                  <div key={line.k} className="flex items-baseline gap-2.5 text-[15px]">
                    <span className="text-[#30A24B]">✓</span>
                    <span className="font-semibold text-white">{line.k}</span>
                    <span className="text-[#85858A]">→</span>
                    <span>{line.v}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        }
        if (block.kind === "ask") {
          return (
            <div
              key={i}
              className="max-w-[74%] rounded-[20px] border border-[#242428] bg-[#141417] px-5 py-[17px]"
            >
              <div className="text-[15.5px] leading-[1.5] text-[#ECECEE]">
                <ChatMarkdown>{block.text}</ChatMarkdown>
              </div>
              {block.detail ? (
                <pre className="mt-3 rounded-xl bg-[#0E0E10] px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-[#85858A]">
                  {block.detail}
                </pre>
              ) : null}
              <div className="mt-3.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => onAnswer("approved")}
                  className="rounded-[11px] bg-[#F1F1EF] px-[17px] py-2 text-[14.5px] font-medium text-[#17171A]"
                >
                  Send it
                </button>
                <button
                  type="button"
                  className="rounded-[11px] border border-[#26262A] px-[17px] py-2 text-[14.5px] text-[#C9C9CE]"
                >
                  Edit first
                </button>
              </div>
            </div>
          );
        }
        if (block.kind === "computer") {
          return (
            <div
              key={i}
              className="w-[340px] rounded-[18px] border border-[#232326] bg-[#17171A] px-[18px] py-4"
            >
              <div className="flex items-center justify-between">
                <span className="text-[15px] font-medium text-[#ECECEE]">Computer</span>
                <span className="rounded-full bg-[rgba(48,162,75,.14)] px-[11px] py-1 text-[13px] text-[#4ECB71]">
                  {block.state}
                </span>
              </div>
              <div className="my-2.5 text-[14.5px] leading-[1.5] text-[#A8A8AD]">
                <ChatMarkdown>{block.text}</ChatMarkdown>
              </div>
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

function CreateBotForm({
  onCreate,
  onCancel,
}: {
  onCreate: (input: { name: string; title: string; description: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-[#85858A]">New bot</span>
        <button type="button" onClick={onCancel}>
          ✕
        </button>
      </div>
      <label className="mt-6 block text-[14px] text-[#85858A]">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name this bot"
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <label className="mt-4 block text-[14px] text-[#85858A]">
        Title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Describe what this bot does"
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <label className="mt-4 block text-[14px] text-[#85858A]">
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this bot is for"
          rows={4}
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <button
        type="button"
        disabled={!name.trim()}
        onClick={() => onCreate({ name, title, description })}
        className="mt-5 rounded-[11px] bg-[#F1F1EF] px-4 py-2 text-[#17171A] disabled:opacity-40"
      >
        Create
      </button>
    </div>
  );
}

function BotSettings({
  bot,
  onSave,
  onExport,
  onDelete,
}: {
  bot: Bot;
  onSave: (patch: {
    name?: string;
    title?: string;
    description?: string;
    instructions?: string;
  }) => Promise<void>;
  onExport: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [description, setDescription] = useState(bot.description);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <div className="flex justify-center">
        <BotAvatar color={bot.color} size={64} />
      </div>
      <label className="mt-6 block text-[14px] text-[#85858A]">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <label className="mt-4 block text-[14px] text-[#85858A]">
        Title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <label className="mt-4 block text-[14px] text-[#85858A]">
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <div className="mt-5 flex flex-col items-start gap-3">
        <button
          type="button"
          onClick={() => void onSave({ name, title, description, instructions: description })}
          className="rounded-[11px] bg-[#F1F1EF] px-4 py-2 text-[#17171A]"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => void onExport()}
          className="text-[14px] text-[#85858A]"
        >
          Export
        </button>
        {confirming ? (
          <div className="w-full rounded-[11px] border border-[#3A1F14] bg-[#1A100C] px-3.5 py-3">
            <p className="text-[13.5px] leading-[1.45] text-[#C9C9CE]">
              This permanently deletes {bot.name}, including thread, computer, memory, and routines.
              Bots it created stay in your list.
            </p>
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                disabled={deleting}
                onClick={() => {
                  setConfirming(false);
                  setError(null);
                }}
                className="text-[14px] text-[#85858A] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => {
                  setDeleting(true);
                  setError(null);
                  void onDelete().catch((err: unknown) => {
                    setError(err instanceof Error ? err.message : "Could not delete bot");
                    setDeleting(false);
                  });
                }}
                className="rounded-[11px] bg-[#E65707] px-3.5 py-1.5 text-[14px] text-[#F1F1EF] disabled:opacity-40"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
            {error ? <p className="mt-2 text-[13px] text-[#E65707]">{error}</p> : null}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-[14px] text-[#E65707]"
          >
            Delete bot
          </button>
        )}
      </div>
    </div>
  );
}

function DeleteBotDialog({
  bot,
  onCancel,
  onConfirm,
}: {
  bot: Bot;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !deleting) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleting, onCancel]);

  return (
    <div
      role="presentation"
      className="absolute inset-0 z-50 grid place-items-center bg-[rgba(4,4,5,.76)] px-5"
      onPointerDown={() => {
        if (!deleting) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-bot-title"
        aria-describedby="delete-bot-description"
        className="w-full max-w-[420px] rounded-[18px] border border-[#343438] bg-[#1A1A1D] p-5 shadow-[0_24px_70px_rgba(0,0,0,.65)]"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h2 id="delete-bot-title" className="text-[17px] font-medium text-[#F1F1F2]">
          Delete {bot.name}?
        </h2>
        <p id="delete-bot-description" className="mt-2 text-[14px] leading-6 text-[#9A9AA0]">
          This permanently deletes its conversation, computer, memory, and routines. Bots it created
          stay in your list.
        </p>
        {error ? <p className="mt-3 text-[13.5px] text-[#FF5364]">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            disabled={deleting}
            onClick={onCancel}
            className="rounded-[10px] px-3.5 py-2 text-[14px] text-[#C9C9CE] hover:bg-[#29292D] disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={() => {
              setDeleting(true);
              setError(null);
              void onConfirm().catch((err: unknown) => {
                setError(err instanceof Error ? err.message : "Could not delete bot");
                setDeleting(false);
              });
            }}
            className="rounded-[10px] bg-[#FF5364] px-3.5 py-2 text-[14px] font-medium text-white disabled:opacity-40"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

function embeddableScreenUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.href);
    const page = new URL(window.location.href);
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    const pagePort = page.port || (page.protocol === "https:" ? "443" : "80");
    if (local && parsed.port && parsed.port !== pagePort) {
      return null;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function screenIframeSandbox(url: string | null) {
  if (!url) return undefined;
  try {
    return new URL(url, window.location.href).pathname.startsWith("/novnc/")
      ? "allow-scripts allow-pointer-lock"
      : undefined;
  } catch {
    return undefined;
  }
}

function computerPlaceholder(
  state: ComputerStatus["state"] | undefined,
  booting: boolean,
  botName: string,
) {
  if (state === "booting" || booting) return "Booting live desktop…";
  if (state === "running") return `${botName}’s screen`;
  if (state === "suspended") return "Computer is asleep — take control to wake it";
  if (state === "error") return "Computer failed to boot";
  return "Computer is stopped";
}
