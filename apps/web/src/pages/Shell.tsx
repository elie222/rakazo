import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type {
  Bot,
  BotSection,
  ComputerMode,
  ComputerStatus,
  Group,
  Me,
  ProductEvent,
  Routine,
  SearchHit,
  TaughtSkill,
  ThreadMessage,
  ThreadSnapshot,
  VoiceInfo,
  VoiceStatus,
  WorkspaceMemoryConfig,
} from "@rakazo/contracts";
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
} from "@rakazo/contracts";
import {
  abortableDelay,
  attachmentsForThread,
  cronFromPreset,
  defaultCronPreset,
  formatCron,
  groupBotsForSidebar,
  hasMentionToken,
  inferAttachmentMimeType,
  isActive,
  isRunTerminalEvent,
  latestAnswerableAskMessageId,
  presetFromCron,
  speechFromBlocks,
} from "@rakazo/core";
import { BotAvatar, Button } from "@rakazo/ui-web";
import {
  ArrowUp,
  ChevronLeft,
  Cpu,
  Gauge,
  LogOut,
  Menu,
  Mic,
  Monitor,
  Paperclip,
  Phone,
  Plus,
  Puzzle,
  Settings,
  Square,
  Volume2,
  X,
} from "lucide-react";
import {
  type Dispatch,
  lazy,
  memo,
  type RefObject,
  type SetStateAction,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArtifactFileCard } from "../components/ArtifactFileCard";
import { SkillDraftCard } from "../components/teach/SkillDraftCard";
import { TeachCaptureOverlay } from "../components/teach/TeachCaptureOverlay";
import { TeachComputerSection } from "../components/teach/TeachComputerSection";
import { TeachRecordingChrome, TeachStopButton } from "../components/teach/TeachRecordingChrome";
import { type ArtifactTarget, decodeArtifactBase64 } from "../lib/artifact-open";
import { authClient } from "../lib/auth";
import { takeInitialBootstrap } from "../lib/bootstrap";
import { dictation } from "../lib/dictation";
import { revokePendingAttachmentPreviews } from "../lib/pending-attachments";
import { markAfterPaint, markOnce } from "../lib/performance";
import { rpc } from "../lib/rpc";
import {
  activeThreadRuns,
  computerPanelAutoBoot,
  isComputerStatusEvent,
  isThreadSnapshotEvent,
  mergeThreadSnapshot,
  prependThreadMessagePage,
  reduceComputerStatus,
  reduceThreadSnapshot,
  userHoldsComputerControl,
} from "../lib/thread-events";
import { speaker } from "../lib/tts";
import type { ContextMenuPosition } from "./BotContextMenu";
import { CreateGroupForm, GroupSettings, memberName } from "./GroupPanel";
import { HostComputerPrompt } from "./HostComputerPrompt";
import { WindowChrome } from "./WindowChrome";
import { WorkspaceSearchResults } from "./WorkspaceSearch";

const BotContextMenu = lazy(() =>
  import("./BotContextMenu").then((module) => ({ default: module.BotContextMenu })),
);
const ModelSettingsOverlay = lazy(() =>
  import("./ModelSettingsOverlay").then((module) => ({ default: module.ModelSettingsOverlay })),
);
const PluginsOverlay = lazy(() =>
  import("./PluginsOverlay").then((module) => ({ default: module.PluginsOverlay })),
);
const MemorySettingsOverlay = lazy(() =>
  import("./MemorySettingsOverlay").then((module) => ({
    default: module.MemorySettingsOverlay,
  })),
);
const RoutineSchedule = lazy(() =>
  import("./RoutineSchedule").then((module) => ({ default: module.RoutineSchedule })),
);
const VoiceSettingsOverlay = lazy(() =>
  import("./VoiceSettingsOverlay").then((module) => ({ default: module.VoiceSettingsOverlay })),
);
const CallView = lazy(() => import("./CallView").then((module) => ({ default: module.CallView })));

type Panel =
  | "computer"
  | "settings"
  | "routine"
  | "create"
  | "create-group"
  | "group-settings"
  | null;

type PendingAttachment = {
  id: string;
  threadKey: string;
  file: File;
  previewUrl?: string;
};

const ATTACHMENT_ACCEPT = ATTACHMENT_ALLOWED_MIME_TYPES.join(",");

export function ShellPage() {
  const { botId, groupId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const session = authClient.useSession();
  const [groups, setGroups] = useState<Group[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [botSections, setBotSections] = useState<BotSection[]>([]);
  const [archivedBots, setArchivedBots] = useState<Bot[]>([]);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [replyTarget, setReplyTarget] = useState<ThreadMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routinesBotId, setRoutinesBotId] = useState<string | null>(null);
  const [taughtSkills, setTaughtSkills] = useState<TaughtSkill[]>([]);
  const [taughtSkillsBotId, setTaughtSkillsBotId] = useState<string | null>(null);
  const [teachBusy, setTeachBusy] = useState(false);
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [memorySettingsOpen, setMemorySettingsOpen] = useState(false);
  const [memoryProviderConfig, setMemoryProviderConfig] = useState<
    WorkspaceMemoryConfig | null | undefined
  >(undefined);
  const memoryProviderConfigRevision = useRef(0);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [dictating, setDictating] = useState(false);
  const [dictationError, setDictationError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [botMenu, setBotMenu] = useState<{
    botId: string;
    position: ContextMenuPosition;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [clearTarget, setClearTarget] = useState<Bot | null>(null);
  const [newSectionBot, setNewSectionBot] = useState<Bot | null>(null);
  const [booting, setBooting] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [initialBotsLoaded, setInitialBotsLoaded] = useState(false);
  const [bootstrapMe, setBootstrapMe] = useState<Me | null>();
  const [routineDraft, setRoutineDraft] = useState({
    name: "",
    prompt: "",
    schedule: defaultCronPreset(),
  });
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null);
  const [deleteRoutineTarget, setDeleteRoutineTarget] = useState<Routine | null>(null);
  const [savingRoutine, setSavingRoutine] = useState(false);
  const [runningRoutine, setRunningRoutine] = useState(false);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);
  const [usage, setUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
    runs: number;
  } | null>(null);
  const autoBooted = useRef<string | null>(null);
  const routineSavePending = useRef(false);
  const routineRunPending = useRef(false);
  const bootstrappedThread = useRef<ThreadSnapshot | null>(null);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const initiallyScrolledThread = useRef<string | null>(null);
  const messageScroll = useRef<HTMLDivElement>(null);
  const pinnedAroundRef = useRef<{
    botId: string;
    messageId: string;
    threadId: string;
    messages: ThreadMessage[];
    olderCursor: number | null;
  } | null>(null);
  const manuallyUnread = useRef(new Set<string>());
  const readVisibleGroups = useRef(new Set<string>());
  const computerVisible = useRef(false);
  computerVisible.current = panel === "computer" || computerOpen;
  const autoSpoken = useRef<string | null>(null);
  const autoSpokenBotId = useRef<string | null>(null);

  const inGroup = Boolean(groupId);
  const active = inGroup ? undefined : (bots.find((b) => b.id === botId) ?? bots[0]);
  const activeGroup = groups.find((group) => group.id === groupId);
  const activePendingAttachments = useMemo(
    () => attachmentsForThread(pendingAttachments, inGroup ? groupId : active?.id),
    [active?.id, groupId, inGroup, pendingAttachments],
  );
  const activeRoutines = !inGroup && routinesBotId === active?.id ? routines : [];
  const activeTaughtSkills = taughtSkillsBotId === active?.id ? taughtSkills : [];
  const recordingSkill = activeTaughtSkills.find((skill) => skill.status === "recording") ?? null;
  const routeBotId = useRef<string | undefined>(botId);
  routeBotId.current = botId;
  const routeGroupId = useRef<string | undefined>(groupId);
  routeGroupId.current = groupId;
  const activeBotId = useRef<string | undefined>(inGroup ? undefined : active?.id);
  activeBotId.current = inGroup ? undefined : active?.id;
  const activeGroupId = useRef<string | undefined>(groupId);
  activeGroupId.current = groupId;
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

  async function refreshBots(includeArchived = false) {
    markOnce("rk:renderer:bots-request-start");
    const [list, sections, archived, groupList] = await Promise.all([
      rpc.bots.list(),
      rpc.botSections.list(),
      includeArchived ? rpc.bots.listArchived() : Promise.resolve(null),
      rpc.groups.list(),
    ]);
    markOnce("rk:renderer:bots-response");
    setBots(list);
    setBotSections(sections);
    setGroups(groupList);
    setInitialBotsLoaded(true);
    if (archived) setArchivedBots(archived);
    if (includeArchived && list.length === 0 && archived?.length === 0 && groupList.length === 0) {
      navigate("/onboarding", { replace: true });
      return;
    }
    const currentGroupId = routeGroupId.current;
    if (currentGroupId) {
      if (!groupList.some((group) => group.id === currentGroupId)) {
        navigate(firstThreadRoute(list, groupList), { replace: true });
      }
      return;
    }
    const currentBotId = routeBotId.current;
    if (!currentBotId || !list.some((bot) => bot.id === currentBotId)) {
      navigate(firstThreadRoute(list, groupList), { replace: true });
    }
  }

  async function refreshGroupThread(id: string) {
    const scrollElement = messageScroll.current;
    const stickToEnd =
      !scrollElement ||
      scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < 80;
    markOnce("rk:renderer:thread-request-start");
    const snap = await rpc.threads.get({ groupId: id });
    markOnce("rk:renderer:thread-response");
    if (activeGroupId.current !== id) return snap;
    setSnapshot((prev) =>
      mergeThreadSnapshot(prev, snap, expandedHistoryThread.current === snap.threadId),
    );
    setComputer(null);
    setRoutines([]);
    setRoutinesBotId(null);
    if (stickToEnd) {
      window.requestAnimationFrame(() => {
        const element = messageScroll.current;
        if (element) element.scrollTop = element.scrollHeight;
      });
    }
    return snap;
  }

  async function refreshThread(id: string) {
    const scrollElement = messageScroll.current;
    const stickToEnd =
      !scrollElement ||
      scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < 80;
    markOnce("rk:renderer:thread-request-start");
    const pin = pinnedAroundRef.current;
    const keepPin = pin?.botId === id;
    const epoch = historyEpoch.current;
    const [snap, routines, skills] = await Promise.all([
      rpc.threads.get({ botId: id }),
      rpc.routines.list({ botId: id }),
      rpc.skills.list({ botId: id }),
      refreshComputerScreen(id),
    ]);
    markOnce("rk:renderer:thread-response");
    // The epoch check drops a response that raced a conversation clear, which would otherwise
    // re-apply the deleted messages and cursor over the emptied snapshot.
    if (activeBotId.current !== id || epoch !== historyEpoch.current) return snap;
    setSnapshot((prev) => {
      let merged = mergeThreadSnapshot(prev, snap, expandedHistoryThread.current === snap.threadId);
      if (keepPin && merged) {
        merged = {
          ...merged,
          messages: pin.messages,
          olderCursor: pin.olderCursor,
        };
      }
      return merged;
    });
    setComputer(snap.computer ?? null);
    setRoutines(routines);
    setRoutinesBotId(id);
    setTaughtSkills(skills);
    setTaughtSkillsBotId(id);
    if (!keepPin && stickToEnd) {
      window.requestAnimationFrame(() => {
        const element = messageScroll.current;
        if (element) element.scrollTop = element.scrollHeight;
      });
    }
    return snap;
  }

  async function refreshComputerScreen(id: string) {
    if (!computerVisible.current) return null;
    const request = ++screenRequest.current;
    const screen = await rpc.computer.screenUrl({ botId: id }).catch(() => ({ url: null }));
    if (
      request !== screenRequest.current ||
      activeBotId.current !== id ||
      !computerVisible.current
    ) {
      return null;
    }
    setScreenUrl(screen.url);
    return screen.url;
  }

  async function loadOlderMessages() {
    const targetBotId = inGroup ? undefined : active?.id;
    const targetGroupId = inGroup ? groupId : undefined;
    const snapshotMatchesTarget = targetGroupId
      ? snapshot?.groupId === targetGroupId
      : snapshot?.botId === targetBotId;
    if (
      (!targetBotId && !targetGroupId) ||
      !snapshotMatchesTarget ||
      snapshot?.olderCursor == null ||
      loadingOlder
    )
      return;
    pinnedAroundRef.current = null;
    const scrollElement = messageScroll.current;
    const previousHeight = scrollElement?.scrollHeight ?? 0;
    const epoch = historyEpoch.current;
    const before = snapshot.olderCursor;
    setLoadingOlder(true);
    try {
      const page = await rpc.threads.messages({
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        before,
      });
      if (
        epoch !== historyEpoch.current ||
        activeBotId.current !== targetBotId ||
        activeGroupId.current !== targetGroupId
      )
        return;
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
    let cancelled = false;
    const providerConfigRevision = memoryProviderConfigRevision.current;
    void rpc.memory
      .providerConfig()
      .then((providerConfig) => {
        if (!cancelled && memoryProviderConfigRevision.current === providerConfigRevision) {
          setMemoryProviderConfig(providerConfig);
        }
      })
      .catch(() => {
        if (!cancelled && memoryProviderConfigRevision.current === providerConfigRevision) {
          setMemoryProviderConfig(null);
        }
      });
    void Promise.all([takeInitialBootstrap(botId), rpc.groups.list()])
      .then(([bootstrap, groupList]) => {
        if (cancelled) return;
        setBootstrapMe(bootstrap.me);
        setBots(bootstrap.bots);
        setBotSections(bootstrap.botSections);
        setArchivedBots(bootstrap.archivedBots);
        setGroups(groupList);
        setInitialBotsLoaded(true);
        if (!groupId && bootstrap.thread) {
          bootstrappedThread.current = bootstrap.thread;
          setSnapshot(bootstrap.thread);
          setComputer(bootstrap.thread.computer ?? null);
          setRoutines(bootstrap.routines);
          setRoutinesBotId(bootstrap.thread.botId ?? null);
          markOnce("rk:renderer:bots-response");
          markOnce("rk:renderer:thread-response");
        }
        if (bootstrap.bots.length === 0 && bootstrap.archivedBots.length === 0) {
          navigate("/onboarding", { replace: true });
          return;
        }
        if (groupId) {
          if (!groupList.some((group) => group.id === groupId)) {
            navigate(firstThreadRoute(bootstrap.bots, groupList), { replace: true });
          }
          return;
        }
        const selectedBotId = bootstrap.thread?.botId ?? bootstrap.bots[0]?.id;
        if (selectedBotId && selectedBotId !== botId) {
          navigate(`/app/${selectedBotId}`, { replace: true });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setBootstrapMe(null);
        void refreshBots(true);
      });
    let refreshTimer: number | undefined;
    const refreshVisibleBots = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void refreshBots().catch(() => undefined), 50);
    };
    window.addEventListener("focus", refreshVisibleBots);
    document.addEventListener("visibilitychange", refreshVisibleBots);
    const poll = window.setInterval(refreshVisibleBots, 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimer);
      window.clearInterval(poll);
      window.removeEventListener("focus", refreshVisibleBots);
      document.removeEventListener("visibilitychange", refreshVisibleBots);
    };
  }, []);

  useEffect(() => {
    void rpc.voice
      .status()
      .then(setVoiceStatus)
      .catch(() => undefined);
    const unsubSpeech = speaker.subscribe((state) => {
      setSpeakingMessageId(state.status === "idle" ? null : (state.messageId ?? null));
    });
    const unsubDictation = dictation.subscribe((state) => {
      setDictating(state.status === "listening" || state.status === "transcribing");
      if (state.error) setDictationError(state.error);
      else if (state.status === "listening") setDictationError(null);
    });
    return () => {
      unsubSpeech();
      unsubDictation();
    };
  }, []);

  useEffect(() => {
    if (!active || !snapshot || snapshot.botId !== active.id) return;
    const lastBot = [...snapshot.messages].reverse().find((message) => message.role === "bot");
    if (autoSpokenBotId.current !== active.id) {
      autoSpokenBotId.current = active.id;
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (callOpen || !active.autoSpeak) {
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (snapshot.run && ["running", "queued", "leased"].includes(snapshot.run.status)) return;
    if (!lastBot || lastBot.id === autoSpoken.current) return;
    const text = speechFromBlocks(lastBot.blocks);
    if (!text) return;
    autoSpoken.current = lastBot.id;
    void speaker.speak(text, { botId: active.id, messageId: lastBot.id });
  }, [
    snapshot?.messages,
    snapshot?.run?.status,
    snapshot?.botId,
    active?.autoSpeak,
    active?.id,
    callOpen,
  ]);

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
    if (!searchParams.get("m")) {
      pinnedAroundRef.current = null;
    }
    screenRequest.current += 1;
    setScreenUrl(null);
    expandedHistoryThread.current = null;
    historyEpoch.current += 1;
    const abort = new AbortController();
    void (async () => {
      const primed = bootstrappedThread.current;
      bootstrappedThread.current = null;
      const snap =
        primed?.botId === active.id ? primed : await refreshThread(active.id).catch(() => null);
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
            if (event.type === "thread.cleared") {
              expandedHistoryThread.current = null;
              pinnedAroundRef.current = null;
              historyEpoch.current += 1;
            }
            if (event.type === "bot.archived") {
              void refreshBots(true).catch(() => undefined);
            } else if (
              event.type === "bot.spawned" ||
              event.type === "bot.deleted" ||
              isRunTerminalEvent(event) ||
              event.type === "thread.cleared"
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
            if (isRunTerminalEvent(event) || event.type === "skill.teaching.stopped") {
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
  }, [active?.id, markBotReadIfVisible, searchParams]);

  useEffect(() => {
    if (!groupId || !activeGroup) return;
    manuallyUnread.current.delete(activeGroup.id);
    readVisibleGroups.current.delete(groupId);
    const markVisibleGroupRead = () => {
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        readVisibleGroups.current.has(groupId)
      )
        return;
      readVisibleGroups.current.add(groupId);
      void rpc.threads
        .markRead({ groupId })
        .then(() => {
          setGroups((current) => {
            const group = current.find((candidate) => candidate.id === groupId);
            if (!group?.unread) return current;
            return current.map((candidate) =>
              candidate.id === groupId ? { ...candidate, unread: false } : candidate,
            );
          });
        })
        .catch(() => {
          readVisibleGroups.current.delete(groupId);
        });
    };
    markVisibleGroupRead();
    window.addEventListener("focus", markVisibleGroupRead);
    document.addEventListener("visibilitychange", markVisibleGroupRead);
    pinnedAroundRef.current = null;
    const abort = new AbortController();
    void (async () => {
      const snap = await refreshGroupThread(groupId).catch(() => null);
      if (abort.signal.aborted) return;
      let cursor = snap?.cursor ?? -1;
      let retryMs = 250;
      while (!abort.signal.aborted) {
        try {
          const events = await rpc.threads.subscribe({ groupId, cursor }, { signal: abort.signal });
          for await (const event of events) {
            if (abort.signal.aborted) break;
            cursor = Math.max(cursor, event.seq);
            retryMs = 250;
            applyThreadEvent(event, setSnapshot, setComputer);
            if (event.type === "thread.message.created" && event.payload.role === "bot") {
              readVisibleGroups.current.delete(groupId);
              markVisibleGroupRead();
            }
            if (isRunTerminalEvent(event)) {
              void refreshGroupThread(groupId).catch(() => undefined);
            }
          }
        } catch {
          // reconnect safely
        }
        if (abort.signal.aborted) break;
        await refreshGroupThread(groupId).catch(() => null);
        await abortableDelay(retryMs, abort.signal);
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    })();
    return () => {
      window.removeEventListener("focus", markVisibleGroupRead);
      document.removeEventListener("visibilitychange", markVisibleGroupRead);
      abort.abort();
    };
  }, [activeGroup?.id, groupId]);

  const filtered = useMemo(
    () => bots.filter((b) => `${b.name} ${b.preview}`.toLowerCase().includes(query.toLowerCase())),
    [bots, query],
  );
  const sidebarGroups = useMemo(
    () => groupBotsForSidebar<Bot>(filtered, botSections),
    [botSections, filtered],
  );
  const workspaceQuery = query.trim();
  const showWorkspaceSearch = workspaceQuery.length > 0;

  useEffect(() => {
    if (!showWorkspaceSearch) {
      setSearchHits([]);
      setSearchLoading(false);
      return;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      void rpc.search
        .query({ q: workspaceQuery })
        .then((result) => {
          if (!abort.signal.aborted) setSearchHits(result.hits);
        })
        .catch(() => {
          if (!abort.signal.aborted) setSearchHits([]);
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearchLoading(false);
        });
    }, 200);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [showWorkspaceSearch, workspaceQuery]);

  async function jumpToSearchHit(hit: SearchHit) {
    setQuery("");
    setSearchHits([]);
    const params = new URLSearchParams();
    if (hit.messageId) params.set("m", hit.messageId);
    if (hit.routineId) params.set("routine", hit.routineId);
    navigate({
      pathname: `/app/${hit.botId}`,
      search: params.toString() ? `?${params.toString()}` : undefined,
    });
  }

  async function jumpToMessage(botId: string, messageId: string) {
    const epoch = historyEpoch.current;
    const [snap, page] = await Promise.all([
      rpc.threads.get({ botId }),
      rpc.threads.messages({ botId, around: { messageId } }),
    ]);
    // The epoch check drops a jump that raced a conversation clear (or a bot switch): applying
    // the fetched page would pin deleted messages that every later refresh keeps restoring.
    if (epoch !== historyEpoch.current) return;
    expandedHistoryThread.current = page.threadId;
    pinnedAroundRef.current = {
      botId,
      messageId,
      threadId: page.threadId,
      messages: page.messages,
      olderCursor: page.olderCursor,
    };
    setSnapshot({
      ...snap,
      messages: page.messages,
      olderCursor: page.olderCursor,
    });
    setComputer(snap.computer ?? null);
    setRoutines(await rpc.routines.list({ botId }));
    setRoutinesBotId(botId);
    window.requestAnimationFrame(() => {
      document
        .querySelector(`[data-message-id="${messageId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  useEffect(() => {
    if (!active) return;
    const messageId = searchParams.get("m");
    const routineId = searchParams.get("routine");
    if (routineId && routinesBotId === active.id) {
      const routine = routines.find((item) => item.id === routineId);
      if (routine) {
        setRoutineDraft({
          name: routine.name,
          prompt: routine.prompt,
          schedule: presetFromCron(routine.cron),
        });
        setPanel("routine");
      } else {
        setPanel("computer");
      }
      const next = new URLSearchParams(searchParams);
      next.delete("routine");
      setSearchParams(next, { replace: true });
    }
    if (messageId) {
      void jumpToMessage(active.id, messageId).finally(() => {
        const next = new URLSearchParams(searchParams);
        next.delete("m");
        setSearchParams(next, { replace: true });
      });
    }
  }, [active?.id, routines, routinesBotId, searchParams, setSearchParams]);
  const activeSnapshot = inGroup
    ? snapshot?.groupId === groupId
      ? snapshot
      : null
    : snapshot?.botId === active?.id
      ? snapshot
      : null;
  const activeReplyTarget =
    replyTarget && activeSnapshot?.messages.some((message) => message.id === replyTarget.id)
      ? replyTarget
      : null;
  const currentRuns = activeThreadRuns(activeSnapshot);
  const answerableAskMessageId = latestAnswerableAskMessageId(activeSnapshot);
  const transcriptRunning = currentRuns.some((run) =>
    ["running", "queued", "leased"].includes(run.status),
  );
  const composerRunning = currentRuns.some((run) => isActive(run.status));
  const transcriptArtifactTarget = useMemo<ArtifactTarget>(
    () => (inGroup ? { groupId: groupId ?? "" } : { botId: active?.id ?? "" }),
    [active?.id, groupId, inGroup],
  );
  const transcriptMembers = activeSnapshot?.members ?? activeGroup?.members;
  const resolveTranscriptMemberName = useCallback(
    (botId: string | undefined) => memberName(transcriptMembers, botId),
    [transcriptMembers],
  );
  const shellReady =
    initialBotsLoaded &&
    (inGroup ? Boolean(activeGroup && activeSnapshot) : Boolean(active && activeSnapshot));
  const refreshThreadRef = useRef(refreshThread);
  refreshThreadRef.current = refreshThread;
  const refreshGroupThreadRef = useRef(refreshGroupThread);
  refreshGroupThreadRef.current = refreshGroupThread;
  const loadOlderMessagesRef = useRef(loadOlderMessages);
  loadOlderMessagesRef.current = loadOlderMessages;

  useLayoutEffect(() => {
    if (initialBotsLoaded) {
      markOnce("rk:renderer:bots-committed");
      markAfterPaint("rk:renderer:bots-painted");
    }
    if (active && snapshot?.botId === active.id) {
      markOnce("rk:renderer:thread-committed");
      markAfterPaint("rk:renderer:thread-painted");
    }
    if (shellReady) {
      markOnce("rk:renderer:shell-ready");
      markAfterPaint("rk:renderer:shell-painted");
    }
  }, [active, initialBotsLoaded, shellReady, snapshot?.botId]);

  useLayoutEffect(() => {
    if (!active || !snapshot || snapshot.botId !== active.id) return;
    if (initiallyScrolledThread.current === snapshot.threadId) return;
    if (pinnedAroundRef.current?.botId === active.id) return;
    const element = messageScroll.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    initiallyScrolledThread.current = snapshot.threadId;
  }, [active, snapshot?.botId, snapshot?.threadId]);

  const openBot = useCallback((id: string) => navigate(`/app/${id}`), [navigate]);
  const loadOlder = useCallback(() => loadOlderMessagesRef.current(), []);
  const answerMessage = useCallback(async (message: ThreadMessage, text: string) => {
    const botId = activeBotId.current;
    const groupId = activeGroupId.current;
    if (!botId && !groupId) return;
    await rpc.threads.answer({
      ...(groupId ? { groupId } : { botId: botId! }),
      runId: message.runId ?? "",
      messageId: message.id,
      answer: text,
    });
    if (groupId && activeGroupId.current === groupId) {
      await refreshGroupThreadRef.current(groupId);
    } else if (botId && activeBotId.current === botId) {
      await refreshThreadRef.current(botId);
    }
  }, []);
  const onAttachmentPick = useCallback(
    async (files: FileList | null) => {
      const threadKey = activeGroupId.current ?? activeBotId.current;
      if (!threadKey || !files?.length) return;
      const existing = attachmentsForThread(pendingAttachments, threadKey);
      const next: PendingAttachment[] = [];
      const skipped: string[] = [];
      for (const file of Array.from(files)) {
        if (existing.length + next.length >= ATTACHMENT_MAX_COUNT) {
          skipped.push(`${file.name} (max ${ATTACHMENT_MAX_COUNT} attachments)`);
          continue;
        }
        if (file.size > ATTACHMENT_MAX_BYTES) {
          skipped.push(`${file.name} (over 10 MiB)`);
          continue;
        }
        const mimeType = inferAttachmentMimeType(file.name, file.type);
        if (!mimeType) {
          skipped.push(file.name);
          continue;
        }
        next.push({
          id: `${file.name}-${file.size}-${file.lastModified}-${next.length}`,
          threadKey,
          file,
          previewUrl: mimeType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        });
      }
      if (next.length) setPendingAttachments((current) => [...current, ...next]);
      setAttachmentNotice(skipped.length ? `Skipped ${skipped.join(", ")}` : null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [pendingAttachments],
  );
  const removeAttachment = useCallback((attachment: PendingAttachment) => {
    revokePendingAttachmentPreviews([attachment]);
    setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id));
  }, []);
  const sendMessage = useCallback(
    async (text: string, mentions?: string[]) => {
      const botTarget = activeBotId.current;
      const groupTarget = activeGroupId.current;
      if ((!botTarget && !groupTarget) || sending) return;
      const attachments = attachmentsForThread(pendingAttachments, groupTarget ?? botTarget);
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      setSending(true);
      setSendError(null);
      try {
        const artifactIds: string[] = [];
        for (const pending of attachments) {
          const mimeType = inferAttachmentMimeType(pending.file.name, pending.file.type);
          if (!mimeType) {
            throw new Error(`Unsupported file type: ${pending.file.name}`);
          }
          const contentBase64 = await readFileAsBase64(pending.file);
          const artifact = await rpc.artifacts.create(
            groupTarget
              ? { groupId: groupTarget, name: pending.file.name, mimeType, contentBase64 }
              : { botId: botTarget!, name: pending.file.name, mimeType, contentBase64 },
          );
          artifactIds.push(artifact.id);
        }
        if (groupTarget) {
          await rpc.threads.send({
            groupId: groupTarget,
            text: trimmed || undefined,
            mentions: mentions?.length ? mentions : undefined,
            artifactIds: artifactIds.length ? artifactIds : undefined,
            replyToMessageId: activeReplyTarget?.id,
          });
        } else if (botTarget) {
          await rpc.threads.send({
            botId: botTarget,
            text: trimmed || undefined,
            artifactIds: artifactIds.length ? artifactIds : undefined,
            replyToMessageId: activeReplyTarget?.id,
          });
        }
        setReplyTarget(null);
        revokePendingAttachmentPreviews(attachments);
        setPendingAttachments((current) =>
          current.filter((attachment) => attachment.threadKey !== (groupTarget ?? botTarget)),
        );
        if (groupTarget && activeGroupId.current === groupTarget) setAttachmentNotice(null);
        if (botTarget && activeBotId.current === botTarget) setAttachmentNotice(null);
        if (groupTarget) await refreshGroupThreadRef.current(groupTarget);
        else if (botTarget) await refreshThreadRef.current(botTarget);
      } catch (error) {
        if (groupTarget && activeGroupId.current === groupTarget) {
          setSendError(error instanceof Error ? error.message : "Failed to send message");
        } else if (botTarget && activeBotId.current === botTarget) {
          setSendError(error instanceof Error ? error.message : "Failed to send message");
        }
      } finally {
        setSending(false);
      }
    },
    [activeReplyTarget?.id, pendingAttachments, sending],
  );
  const followUpMessage = useCallback(async (text: string) => {
    const id = activeBotId.current;
    if (!id) return;
    await rpc.threads.followUp({ botId: id, text });
    await refreshThreadRef.current(id);
  }, []);
  const stopRun = useCallback(async () => {
    const botTarget = activeBotId.current;
    const groupTarget = activeGroupId.current;
    if (groupTarget) {
      await rpc.threads.stop({ groupId: groupTarget });
      await refreshGroupThreadRef.current(groupTarget);
      return;
    }
    if (!botTarget) return;
    await rpc.threads.stop({ botId: botTarget });
    await refreshThreadRef.current(botTarget);
  }, []);
  const stopTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id || teachBusy) return;
    const recording = taughtSkills.find(
      (skill) => skill.status === "recording" && taughtSkillsBotId === id,
    );
    if (!recording) return;
    setTeachBusy(true);
    try {
      await rpc.skills.stop({ skillId: recording.id });
      await refreshThreadRef.current(id);
      setComputerOpen(false);
    } finally {
      setTeachBusy(false);
    }
  }, [teachBusy, taughtSkills, taughtSkillsBotId]);
  // Transcript and MessageView are memoized; these must stay referentially stable or every
  // Shell state change re-renders the whole transcript.
  const refreshActiveThread = useCallback(async () => {
    const groupId = activeGroupId.current;
    if (groupId) {
      await refreshGroupThreadRef.current(groupId);
      return;
    }
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
  }, []);
  const addSkillRoutine = useCallback((name: string, prompt: string) => {
    setRoutineDraft({ name, prompt, schedule: defaultCronPreset() });
    setEditingRoutine(null);
    setPanel("routine");
  }, []);
  const speakingMessageIdRef = useRef(speakingMessageId);
  speakingMessageIdRef.current = speakingMessageId;
  const speakMessage = useCallback((message: ThreadMessage) => {
    if (speakingMessageIdRef.current === message.id) {
      speaker.stop();
      return;
    }
    const text = speechFromBlocks(message.blocks);
    const id = message.botId ?? activeBotId.current;
    if (text && id) void speaker.speak(text, { botId: id, messageId: message.id });
  }, []);

  async function createGroup(input: { name: string; botIds: string[] }) {
    const group = await rpc.groups.create(input);
    setPanel(null);
    await refreshBots();
    navigate(`/app/g/${group.id}`);
  }

  async function createBot(input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
  }) {
    const bot = await rpc.bots.create({
      name: input.name.trim(),
      title: input.title,
      description: input.description,
      instructions: input.description,
      notifyOnFinish: true,
      computerMode: input.computerMode,
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
    const botId = active.id;
    let cancelled = false;
    void (async () => {
      // Refresh from the server first. A stale SSE "booting" snapshot used to
      // skip this effect, so an RPC takeover never showed "You have control".
      const snap = await refreshThread(botId).catch(() => null);
      if (cancelled || activeBotId.current !== botId) return;
      const state = snap?.computer?.state;
      const screen = state === "running" ? await refreshComputerScreen(botId) : null;
      if (cancelled || activeBotId.current !== botId) return;
      const action = computerPanelAutoBoot(state, screen);
      if (action === "wait") {
        if (state === "running") autoBooted.current = botId;
        return;
      }
      if (action === "boot" && autoBooted.current === botId) return;
      autoBooted.current = botId;
      await bootComputer({
        takeControl: false,
        overlay: action === "boot",
        force: true,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [panel, active?.id]);

  useEffect(() => {
    setComputerOpen(false);
  }, [active?.id]);

  // The routine panel copies a routine's data into local draft state at click time
  // rather than deriving it from `active`, so it goes stale across a bot switch —
  // without this, Save on bot B could silently update bot A's routine.
  useEffect(() => {
    setEditingRoutine(null);
    setDeleteRoutineTarget(null);
    setPanel((current) => (current === "routine" ? null : current));
  }, [active?.id]);

  useEffect(() => {
    const threadKey = inGroup ? groupId : active?.id;
    setPendingAttachments((current) => {
      const stale = current.filter((attachment) => attachment.threadKey !== threadKey);
      revokePendingAttachmentPreviews(stale);
      return attachmentsForThread(current, threadKey);
    });
    setReplyTarget(null);
    setAttachmentNotice(null);
    setSendError(null);
  }, [active?.id, groupId, inGroup]);

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
    const needsTakeover = !userHoldsComputerControl(computer, active.id);
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
  const hasControl = userHoldsComputerControl(computer, active?.id);

  const userName = session.data?.user.name ?? "You";
  const initials = userName
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      data-testid="shell-root"
      data-ready={shellReady}
      className="relative flex h-full min-w-0 overflow-hidden bg-[#050506] text-[#DFDFE2]"
    >
      {bootstrapMe !== undefined ? (
        <HostComputerPrompt initialMe={bootstrapMe ?? undefined} />
      ) : null}
      {mobileSidebarOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setMobileSidebarOpen(false)}
          className="absolute inset-y-0 right-0 left-[min(calc(100%-48px),316px)] z-30 bg-black/60 md:hidden"
        />
      ) : null}
      <aside
        className={`absolute inset-y-0 left-0 z-40 flex w-[calc(100%-48px)] max-w-[316px] shrink-0 flex-col border-r border-[#171719] bg-[#0B0B0C] transition-transform md:static md:z-auto md:w-[316px] md:translate-x-0 ${
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="app-drag flex items-center justify-between px-[18px] pb-3 pt-4">
          <WindowChrome />
          <div className="relative">
            <button
              type="button"
              onClick={() => setCreateMenuOpen((open) => !open)}
              className="app-no-drag text-[21px] text-[#7A7A80] hover:text-[#C9C9CE]"
              title="Create"
            >
              +
            </button>
            {createMenuOpen ? (
              <div className="app-no-drag absolute right-0 top-full z-20 mt-2 min-w-[160px] rounded-xl border border-[#26262A] bg-[#141416] py-1 shadow-lg">
                <button
                  type="button"
                  className="block w-full px-3.5 py-2 text-left text-[14px] text-[#ECECEE] hover:bg-[#1A1A1D]"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    setPanel("create");
                  }}
                >
                  New bot
                </button>
                <button
                  type="button"
                  className="block w-full px-3.5 py-2 text-left text-[14px] text-[#ECECEE] hover:bg-[#1A1A1D]"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    setPanel("create-group");
                  }}
                >
                  New group
                </button>
              </div>
            ) : null}
          </div>
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
          {showWorkspaceSearch ? (
            <WorkspaceSearchResults
              hits={searchHits}
              loading={searchLoading}
              onSelect={(hit) => void jumpToSearchHit(hit)}
            />
          ) : (
            sidebarGroups.map((group) => (
              <div key={group.key} data-sidebar-group={group.key}>
                {group.title ? (
                  <div className="px-2.5 pb-1 pt-3 text-[12.5px] font-medium text-[#6C6C70]">
                    {group.title}
                  </div>
                ) : null}
                {group.bots.map((bot) => (
                  <button
                    key={bot.id}
                    type="button"
                    onClick={() => {
                      setMobileSidebarOpen(false);
                      navigate(`/app/${bot.id}`);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setBotMenu({
                        botId: bot.id,
                        position: { x: event.clientX, y: event.clientY },
                      });
                    }}
                    className="flex w-full gap-3 rounded-xl px-2.5 py-[11px] text-left"
                    style={{
                      background: !inGroup && active?.id === bot.id ? "#161618" : "transparent",
                    }}
                  >
                    <BotAvatar color={bot.color} size={38} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className={`truncate text-[15px] text-[#ECECEE] ${
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
            ))
          )}
          {!showWorkspaceSearch
            ? groups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => {
                    setMobileSidebarOpen(false);
                    navigate(`/app/g/${group.id}`);
                  }}
                  className="flex gap-3 rounded-xl px-2.5 py-[11px] text-left"
                  style={{
                    background: inGroup && activeGroup?.id === group.id ? "#161618" : "transparent",
                  }}
                >
                  <span className="grid h-[38px] w-[38px] place-items-center rounded-full bg-[#232326] text-[13px] text-[#C9C9CE]">
                    G
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className={`text-[15px] text-[#ECECEE] ${
                          group.unread ? "font-semibold" : "font-medium"
                        }`}
                      >
                        {group.name}
                      </span>
                      {group.unread ? (
                        <span
                          aria-hidden="true"
                          className="inline-block h-2 w-2 rounded-full bg-[#8B5CF6]"
                        />
                      ) : null}
                    </div>
                    <div className="mt-0.5 truncate text-[13.5px] text-[#85858A]">
                      {group.members.map((member) => member.name).join(", ")}
                    </div>
                  </div>
                </button>
              ))
            : null}
          {archivedBots.length > 0 && !showWorkspaceSearch ? (
            <div className="mt-2 border-t border-[#202023] pt-2">
              <button
                type="button"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((open) => !open)}
                className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[13.5px] text-[#85858A] hover:bg-[#131315]"
              >
                <span>Archived</span>
                <span>{archivedBots.length}</span>
              </button>
              {archivedOpen
                ? archivedBots.map((bot) => (
                    <div key={bot.id} className="flex items-center gap-2 rounded-lg px-2.5 py-2">
                      <BotAvatar color={bot.color} size={28} />
                      <span className="min-w-0 flex-1 truncate text-[14px] text-[#A8A8AD]">
                        {bot.name}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          void rpc.bots.restore({ botId: bot.id }).then(() => refreshBots(true))
                        }
                        className="text-[12.5px] text-[#C9C9CE] hover:text-white"
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${bot.name}`}
                        onClick={() => setDeleteTarget(bot)}
                        className="text-[12.5px] text-[#FF5364]"
                      >
                        Delete
                      </button>
                    </div>
                  ))
                : null}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setPluginsOpen(true)}
          className="mx-3 mb-1 flex items-center gap-3 rounded-[11px] px-2.5 py-2 hover:bg-[#131315]"
        >
          <span className="grid h-[30px] w-[30px] place-items-center rounded-full bg-[#17171A] text-[#9A9AA0]">
            <Puzzle size={15} strokeWidth={1.7} />
          </span>
          <span className="text-[14.5px] text-[#C9C9CE]">Plugins</span>
        </button>
        <div className="relative">
          {menuOpen ? (
            <div className="absolute bottom-14 left-3 right-3 rounded-2xl border border-[#2A2A2F] bg-[#1A1A1D] p-2 shadow-[0_22px_50px_rgba(0,0,0,.55)]">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setModelsOpen(true);
                }}
                className="flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 hover:bg-[#232327]"
              >
                <Cpu size={16} strokeWidth={1.7} className="text-[#9A9AA0]" />
                <span className="flex-1 text-left text-[14.5px] text-[#ECECEE]">Models</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setMemorySettingsOpen(true);
                }}
                className="flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 hover:bg-[#232327]"
              >
                <span className="text-[#9A9AA0]">◇</span>
                <span className="flex-1 text-left text-[14.5px] text-[#ECECEE]">Memory</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setVoiceOpen(true);
                }}
                className="flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 hover:bg-[#232327]"
              >
                <Volume2 size={16} strokeWidth={1.7} className="text-[#9A9AA0]" />
                <span className="flex-1 text-left text-[14.5px] text-[#ECECEE]">Voice</span>
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 hover:bg-[#232327]"
                onClick={async () => {
                  setUsage(await rpc.usage.summary());
                }}
              >
                <Gauge size={16} strokeWidth={1.7} className="text-[#9A9AA0]" />
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
                <LogOut size={16} strokeWidth={1.7} className="text-[#9A9AA0]" />
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
        <div className="flex items-center justify-between border-b border-[#141416] px-3 py-[17px] md:px-[22px]">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              aria-label="Open navigation"
              onClick={() => setMobileSidebarOpen(true)}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[#A8A8AD] hover:bg-[#1B1B1E] md:hidden"
            >
              <Menu size={19} strokeWidth={1.7} />
            </button>
            <button
              type="button"
              data-testid="bot-settings-trigger"
              onClick={() => setPanel(inGroup ? "group-settings" : "settings")}
              className="flex min-w-0 items-center gap-3"
            >
              {inGroup ? (
                <span className="grid h-[26px] w-[26px] place-items-center rounded-full bg-[#232326] text-[11px] text-[#C9C9CE]">
                  G
                </span>
              ) : active ? (
                <BotAvatar color={active.color} size={26} />
              ) : null}
              <span className="min-w-0">
                <span className="block truncate text-[16px] font-medium text-[#ECECEE]">
                  {inGroup
                    ? (activeGroup?.name ?? activeSnapshot?.groupName ?? "Group")
                    : (active?.name ?? "Select a bot")}
                </span>
              </span>
            </button>
          </div>
          <div className="flex items-center gap-1">
            {!inGroup && active ? (
              <button
                type="button"
                title={voiceStatus?.ready ? "Call" : "Set up voice to call"}
                aria-label="Call"
                onClick={() => {
                  if (!voiceStatus?.ready) {
                    setVoiceOpen(true);
                    return;
                  }
                  setCallOpen(true);
                }}
                className="grid h-[30px] w-[34px] place-items-center rounded-[9px] hover:bg-[#1B1B1E]"
                style={{ background: callOpen ? "#1B1B1E" : "transparent" }}
              >
                <Phone size={16} strokeWidth={1.6} className="text-[#A8A8AD]" />
              </button>
            ) : null}
            {!inGroup ? (
              <button
                type="button"
                title="Agent computer"
                onClick={() => setPanel((p) => (p === "computer" ? null : "computer"))}
                className="grid h-[30px] w-[34px] place-items-center rounded-[9px] hover:bg-[#1B1B1E]"
                style={{ background: panel ? "#1B1B1E" : "transparent" }}
              >
                <Monitor size={18} strokeWidth={1.6} className="text-[#A8A8AD]" />
              </button>
            ) : null}
          </div>
        </div>
        <Transcript
          scrollRef={messageScroll}
          artifactTarget={transcriptArtifactTarget}
          messages={activeSnapshot?.messages ?? []}
          olderCursor={activeSnapshot?.olderCursor ?? null}
          loadingOlder={loadingOlder}
          answerableAskMessageId={answerableAskMessageId}
          running={transcriptRunning}
          onLoadOlder={loadOlder}
          onOpenBot={openBot}
          onAnswer={answerMessage}
          onReply={setReplyTarget}
          memberName={resolveTranscriptMemberName}
          onRefresh={refreshActiveThread}
          onAddRoutine={addSkillRoutine}
          voiceReady={Boolean(voiceStatus?.ready)}
          speakingMessageId={speakingMessageId}
          onSpeak={speakMessage}
        />
        {recordingSkill ? (
          <div className="px-6 pb-2 text-center text-[13px] text-[#E65707]">
            Teaching in progress — stop teaching before sending a new message.
          </div>
        ) : null}
        <Composer
          key={inGroup ? `group:${groupId}` : `bot:${active?.id}`}
          activeName={inGroup ? (activeGroup?.name ?? activeSnapshot?.groupName) : active?.name}
          running={composerRunning}
          disabled={Boolean(recordingSkill)}
          pendingAttachments={activePendingAttachments}
          attachmentNotice={attachmentNotice}
          sendError={sendError}
          dictationError={dictationError}
          sending={sending}
          fileInputRef={fileInputRef}
          onAttachmentPick={onAttachmentPick}
          onRemoveAttachment={removeAttachment}
          onSend={sendMessage}
          onStop={stopRun}
          replyTarget={activeReplyTarget}
          onClearReply={() => setReplyTarget(null)}
          mentionMembers={
            inGroup
              ? (activeSnapshot?.members ?? activeGroup?.members)?.map((member) => ({
                  botId: member.botId,
                  name: member.name,
                }))
              : undefined
          }
          dictating={dictating}
          transcribe={Boolean(voiceStatus?.transcribe)}
          onDictateStart={(onFinal) => {
            void dictation.listen({
              mode: "hold",
              transcribe: Boolean(voiceStatus?.transcribe),
              onFinal,
            });
          }}
          onDictateStop={() => dictation.submitHold()}
        />
      </main>

      <aside
        data-testid="side-panel"
        data-panel={panel ?? "closed"}
        className={`absolute inset-y-0 right-0 z-20 flex min-h-0 shrink-0 flex-col overflow-hidden bg-[#0A0A0B] transition-[width] duration-150 ease-out md:relative ${
          panel && (active || activeGroup)
            ? "w-full max-w-[384px] border-l border-[#141416] md:w-[384px] md:max-w-none"
            : "pointer-events-none w-0"
        }`}
      >
        {panel && (active || activeGroup) ? (
          <div className="rk-scroll h-full w-full overflow-y-auto px-5 py-[17px] md:w-[384px]">
            {panel !== "routine" &&
            panel !== "create" &&
            panel !== "create-group" &&
            panel !== "group-settings" ? (
              <div className="mb-4 flex items-center justify-between">
                <span className="text-[13.5px] text-[#85858A]">
                  {active ? (computer?.state ?? active.status) : "group"}
                </span>
                <div className="flex gap-3.5">
                  <button
                    type="button"
                    aria-label="Bot settings"
                    onClick={() => setPanel("settings")}
                  >
                    <Settings size={16} strokeWidth={1.7} />
                  </button>
                  <button type="button" aria-label="Close panel" onClick={() => setPanel(null)}>
                    <X size={16} strokeWidth={1.8} />
                  </button>
                </div>
              </div>
            ) : null}
            {panel === "computer" && active ? (
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
                      {computerPlaceholder(
                        computer?.state,
                        booting,
                        computerLabel(computer?.mode, active.name),
                      )}
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
                    {computer?.busyBotName
                      ? `${computer.busyBotName} is using it`
                      : hasControl
                        ? "You have control"
                        : computer?.state === "suspended"
                          ? "Asleep"
                          : computerLabel(computer?.mode, active.name)}
                  </span>
                  {hasControl ? (
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
                {activeRoutines.map((routine) => (
                  <button
                    key={routine.id}
                    type="button"
                    onClick={() => {
                      setRoutineDraft({
                        name: routine.name,
                        prompt: routine.prompt,
                        schedule: presetFromCron(routine.cron),
                      });
                      setEditingRoutine(routine);
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
                  onClick={() => {
                    setRoutineDraft({ name: "", prompt: "", schedule: defaultCronPreset() });
                    setEditingRoutine(null);
                    setPanel("routine");
                  }}
                  className="mt-1 flex items-center gap-2.5 px-2.5 py-2.5 text-[14.5px] text-[#7A7A80]"
                >
                  + New routine
                </button>
                {active ? (
                  <TeachComputerSection
                    botId={active.id}
                    computer={computer}
                    skills={activeTaughtSkills}
                    busy={teachBusy}
                    onRefresh={refreshActiveThread}
                    onOpenComputer={openComputer}
                    onStopTeaching={stopTeaching}
                    onAddRoutine={(skill) => {
                      setRoutineDraft({
                        name: skill.name || skill.goal.slice(0, 80),
                        prompt: `Run taught skill: ${skill.name || skill.goal}\n${skill.playbook.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
                        schedule: defaultCronPreset(),
                      });
                      setEditingRoutine(null);
                      setPanel("routine");
                    }}
                  />
                ) : null}
              </div>
            ) : null}
            {panel === "create-group" ? (
              <CreateGroupForm
                bots={bots}
                onCancel={() => setPanel(null)}
                onCreate={(input) => void createGroup(input)}
              />
            ) : null}
            {panel === "group-settings" && activeGroup ? (
              <GroupSettings
                key={activeGroup.id}
                group={activeGroup}
                bots={bots}
                onSave={async (input) => {
                  await rpc.groups.update({ groupId: activeGroup.id, ...input });
                  await refreshBots();
                  await refreshGroupThread(activeGroup.id);
                  setPanel(null);
                }}
                onRemove={async () => {
                  await rpc.groups.remove({ groupId: activeGroup.id });
                  setPanel(null);
                  await refreshBots();
                }}
              />
            ) : null}
            {panel === "create" ? (
              <CreateBotForm
                onCancel={() => setPanel(null)}
                onCreate={(input) => void createBot(input)}
              />
            ) : null}
            {panel === "settings" && active ? (
              <BotSettings
                key={active.id}
                bot={active}
                memoryProviderConfigured={memoryProviderConfig != null}
                onSave={async ({ computerMode, ...patch }) => {
                  if (computerMode !== active.computerMode) {
                    await rpc.bots.setComputer({
                      botId: active.id,
                      mode: computerMode,
                    });
                  }
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
                onClear={() => setClearTarget(active)}
              />
            ) : null}
            {panel === "routine" && active ? (
              <div>
                <div className="mb-5 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setPanel("computer")}
                    className="text-[#9A9AA0]"
                  >
                    <ChevronLeft size={18} strokeWidth={1.8} />
                  </button>
                  <div className="text-[15.5px] font-medium text-[#F1F1F2]">Routine</div>
                  <button type="button" onClick={() => setPanel(null)} className="text-[#6C6C70]">
                    <X size={16} strokeWidth={1.8} />
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
                  <Suspense fallback={null}>
                    <RoutineSchedule
                      value={routineDraft.schedule}
                      onChange={(schedule) => setRoutineDraft((s) => ({ ...s, schedule }))}
                    />
                  </Suspense>
                </div>
                <div className="mt-5 flex items-center gap-3">
                  <button
                    type="button"
                    disabled={savingRoutine || runningRoutine}
                    onClick={async () => {
                      if (routineSavePending.current) return;
                      const targetBotId = active.id;
                      const targetRoutine = editingRoutine;
                      if (targetRoutine && targetRoutine.botId !== targetBotId) return;
                      routineSavePending.current = true;
                      setSavingRoutine(true);
                      try {
                        if (targetRoutine) {
                          await rpc.routines.update({
                            routineId: targetRoutine.id,
                            name: routineDraft.name || "Routine",
                            prompt: routineDraft.prompt || "Check in.",
                            cron: cronFromPreset(routineDraft.schedule),
                          });
                        } else {
                          await rpc.routines.create({
                            botId: targetBotId,
                            name: routineDraft.name || "Routine",
                            prompt: routineDraft.prompt || "Check in.",
                            cron: cronFromPreset(routineDraft.schedule),
                            timezone: "UTC",
                            active: true,
                            notify: true,
                          });
                        }
                        if (activeBotId.current !== targetBotId) return;
                        await refreshThread(targetBotId);
                        if (activeBotId.current === targetBotId) setPanel("computer");
                      } finally {
                        routineSavePending.current = false;
                        setSavingRoutine(false);
                      }
                    }}
                    className="rounded-[11px] bg-[#F1F1EF] px-4 py-2 text-[#17171A] disabled:opacity-40"
                  >
                    {savingRoutine ? "Saving…" : "Save"}
                  </button>
                  {editingRoutine?.botId === active.id ? (
                    <>
                      <button
                        type="button"
                        disabled={savingRoutine || runningRoutine}
                        onClick={async () => {
                          if (routineRunPending.current) return;
                          const targetBotId = active.id;
                          const targetRoutine = editingRoutine;
                          if (!targetRoutine) return;
                          routineRunPending.current = true;
                          setRunningRoutine(true);
                          try {
                            await rpc.routines.testRun({ routineId: targetRoutine.id });
                            await refreshThread(targetBotId);
                          } finally {
                            routineRunPending.current = false;
                            setRunningRoutine(false);
                          }
                        }}
                        className="rounded-[11px] border border-[#26262A] px-4 py-2 text-[14px] text-[#ECECEE] disabled:opacity-40"
                      >
                        {runningRoutine ? "Running…" : "Run now"}
                      </button>
                      <button
                        type="button"
                        disabled={savingRoutine || runningRoutine}
                        onClick={() => setDeleteRoutineTarget(editingRoutine)}
                        className="rounded-[11px] px-4 py-2 text-[14px] text-[#FF5364] disabled:opacity-40"
                      >
                        Delete routine
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </aside>

      <Suspense fallback={null}>
        {contextBot && botMenu ? (
          <BotContextMenu
            bot={contextBot}
            position={botMenu.position}
            onClose={closeBotMenu}
            sections={botSections}
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
            onMoveToSection={(sectionId) => {
              setBotMenu(null);
              if (sectionId === contextBot.sectionId) return;
              void rpc.bots.update({ botId: contextBot.id, sectionId }).then(() => refreshBots());
            }}
            onCreateSection={() => {
              setNewSectionBot(contextBot);
              setBotMenu(null);
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
            onClear={() => {
              setClearTarget(contextBot);
              setBotMenu(null);
            }}
            onArchive={() => {
              setBotMenu(null);
              void rpc.bots.archive({ botId: contextBot.id }).then(() => refreshBots(true));
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
            onConfirm={async (deleteMemories) => {
              await rpc.bots.remove({ botId: deleteTarget.id, deleteMemories });
              setDeleteTarget(null);
              setPanel(null);
              await refreshBots(true);
            }}
          />
        ) : null}

        {newSectionBot ? (
          <NewBotSectionDialog
            bot={newSectionBot}
            onCancel={() => setNewSectionBot(null)}
            onConfirm={async (name) => {
              await rpc.botSections.create({ botId: newSectionBot.id, name });
              setNewSectionBot(null);
              await refreshBots();
            }}
          />
        ) : null}

        {clearTarget ? (
          <ClearConversationDialog
            bot={clearTarget}
            onCancel={() => setClearTarget(null)}
            onConfirm={async () => {
              await rpc.threads.clear({ botId: clearTarget.id });
              if (active?.id === clearTarget.id) {
                expandedHistoryThread.current = null;
                pinnedAroundRef.current = null;
                historyEpoch.current += 1;
                setSnapshot((current) =>
                  current ? { ...current, messages: [], olderCursor: null, run: null } : current,
                );
              }
              setClearTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {deleteRoutineTarget ? (
          <DeleteRoutineDialog
            routine={deleteRoutineTarget}
            onCancel={() => setDeleteRoutineTarget(null)}
            onConfirm={async () => {
              const target = deleteRoutineTarget;
              await rpc.routines.remove({ routineId: target.id });
              setDeleteRoutineTarget(null);
              setEditingRoutine((current) => (current?.id === target.id ? null : current));
              if (activeBotId.current !== target.botId) return;
              await refreshThread(target.botId);
              if (activeBotId.current === target.botId) setPanel("computer");
            }}
          />
        ) : null}

        {pluginsOpen ? <PluginsOverlay onClose={() => setPluginsOpen(false)} /> : null}
      </Suspense>

      <Suspense fallback={null}>
        {modelsOpen ? <ModelSettingsOverlay onClose={() => setModelsOpen(false)} /> : null}
        {voiceOpen ? (
          <VoiceSettingsOverlay
            onClose={() => {
              setVoiceOpen(false);
              void rpc.voice
                .status()
                .then(setVoiceStatus)
                .catch(() => undefined);
            }}
          />
        ) : null}
        {callOpen && active ? (
          <CallView
            botId={active.id}
            botName={active.name}
            transcribe={Boolean(voiceStatus?.transcribe)}
            snapshot={activeSnapshot}
            onSend={sendMessage}
            onFollowUp={followUpMessage}
            onAnswer={answerMessage}
            onClose={() => setCallOpen(false)}
          />
        ) : null}
      </Suspense>

      <Suspense fallback={null}>
        {memorySettingsOpen ? (
          <MemorySettingsOverlay
            onClose={() => setMemorySettingsOpen(false)}
            config={memoryProviderConfig}
            onConfigChange={(config) => {
              memoryProviderConfigRevision.current += 1;
              setMemoryProviderConfig(config);
            }}
          />
        ) : null}
      </Suspense>

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
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <BotAvatar color={active.color} size={28} />
              {recordingSkill ? (
                <TeachRecordingChrome
                  recording={recordingSkill}
                  busy={teachBusy}
                  onStop={stopTeaching}
                  variant="overlay"
                />
              ) : (
                <span className="truncate text-[15.5px] font-medium text-[#ECECEE]">
                  {computerLabel(computer?.mode, active.name)}
                </span>
              )}
              {!recordingSkill && hasControl ? (
                <span className="rounded-full bg-[rgba(48,162,75,.14)] px-[11px] py-1 text-[13px] text-[#4ECB71]">
                  You have control
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              {recordingSkill ? (
                <TeachStopButton busy={teachBusy} onStop={stopTeaching} />
              ) : hasControl ? (
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
                <X size={16} strokeWidth={1.8} />
              </button>
            </div>
          </div>
          <div className="relative min-h-0 flex-1 bg-[#0E0E10]">
            {computer?.kind === "desktop" ? (
              <div className="grid h-full place-items-center px-8 text-center text-sm text-[#6C6C70]">
                This bot runs on this computer. There is no separate Linux desktop. Ask it to use
                the shell; working directories under your home folder are allowed.
              </div>
            ) : computer?.state === "running" && embeddedScreenUrl ? (
              <>
                <iframe
                  title="Bot screen"
                  src={embeddedScreenUrl}
                  sandbox={screenIframeSandbox(embeddedScreenUrl)}
                  className="h-full w-full border-0 bg-black"
                  allow="clipboard-read; clipboard-write; fullscreen"
                  style={{
                    pointerEvents: recordingSkill || !hasControl ? "none" : "auto",
                  }}
                />
                {active ? (
                  <TeachCaptureOverlay
                    botId={active.id}
                    skill={recordingSkill}
                    enabled={Boolean(recordingSkill)}
                    screenWidth={computer?.screenWidth}
                    screenHeight={computer?.screenHeight}
                  />
                ) : null}
              </>
            ) : (
              <div className="grid h-full place-items-center text-sm text-[#6C6C70]">
                {computer?.state === "suspended"
                  ? "Computer is asleep"
                  : computerLabel(computer?.mode, active.name)}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const Transcript = memo(function Transcript({
  scrollRef,
  artifactTarget,
  messages,
  olderCursor,
  loadingOlder,
  answerableAskMessageId,
  running,
  onLoadOlder,
  onOpenBot,
  onAnswer,
  onReply,
  memberName,
  onRefresh,
  onAddRoutine,
  voiceReady,
  speakingMessageId,
  onSpeak,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  artifactTarget: ArtifactTarget;
  messages: ThreadMessage[];
  olderCursor: number | null;
  loadingOlder: boolean;
  answerableAskMessageId: string | null;
  running: boolean;
  onLoadOlder: () => void | Promise<void>;
  onOpenBot: (botId: string) => void;
  onAnswer: (message: ThreadMessage, text: string) => Promise<void>;
  onReply: (message: ThreadMessage) => void;
  memberName?: (botId: string | undefined) => string | undefined;
  onRefresh: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speakingMessageId: string | null;
  onSpeak: (message: ThreadMessage) => void;
}) {
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  return (
    <div
      ref={scrollRef}
      data-testid="transcript"
      className="rk-scroll flex flex-1 flex-col gap-[13px] overflow-y-auto px-4 py-5 md:px-7 md:py-6"
    >
      {olderCursor != null ? (
        <button
          type="button"
          disabled={loadingOlder}
          onClick={() => void onLoadOlder()}
          className="self-center rounded-lg px-3 py-1.5 text-[13px] text-[#85858A] hover:bg-[#1A1A1D] hover:text-[#C9C9CE] disabled:opacity-50"
        >
          {loadingOlder ? "Loading…" : "Load earlier messages"}
        </button>
      ) : null}
      {messages.map((message) => (
        <div key={message.id} data-message-id={message.id} className="group/message relative">
          <button
            type="button"
            aria-label="Reply"
            onClick={() => onReply(message)}
            className="absolute right-0 top-0 rounded px-2 py-1 text-[12px] text-[#85858A] opacity-0 group-hover/message:opacity-100 hover:text-[#ECECEE] focus:opacity-100"
          >
            Reply
          </button>
          <MessageView
            artifactTarget={artifactTarget}
            message={message}
            canAnswer={message.id === answerableAskMessageId}
            onOpenBot={onOpenBot}
            onAnswer={onAnswer}
            speakerName={message.role === "bot" ? memberName?.(message.botId) : undefined}
            memberName={memberName}
            replyPreview={
              message.replyToMessageId ? messageById.get(message.replyToMessageId) : undefined
            }
            onRefresh={onRefresh}
            onAddRoutine={onAddRoutine}
            voiceReady={voiceReady}
            speaking={speakingMessageId === message.id}
            onSpeak={() => onSpeak(message)}
          />
        </div>
      ))}
      {running ? (
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
  );
});

const Composer = memo(function Composer({
  activeName,
  running,
  disabled,
  pendingAttachments,
  attachmentNotice,
  sendError,
  dictationError,
  sending,
  fileInputRef,
  onAttachmentPick,
  onRemoveAttachment,
  onSend,
  onStop,
  replyTarget,
  onClearReply,
  mentionMembers,
  dictating,
  transcribe,
  onDictateStart,
  onDictateStop,
}: {
  activeName?: string;
  running: boolean;
  disabled?: boolean;
  pendingAttachments: PendingAttachment[];
  attachmentNotice: string | null;
  sendError: string | null;
  dictationError: string | null;
  sending: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAttachmentPick: (files: FileList | null) => void | Promise<void>;
  onRemoveAttachment: (attachment: PendingAttachment) => void;
  onSend: (text: string, mentions?: string[]) => Promise<void>;
  onStop: () => Promise<void>;
  replyTarget?: ThreadMessage | null;
  onClearReply?: () => void;
  mentionMembers?: Array<{ botId: string; name: string }>;
  dictating: boolean;
  transcribe: boolean;
  onDictateStart: (onFinal: (text: string) => void) => void;
  onDictateStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<Array<{ botId: string; name: string }>>(
    [],
  );
  const canSend = draft.trim().length > 0 || pendingAttachments.length > 0;

  function updateDraft(value: string) {
    setDraft(value);
    setSelectedMentions((current) =>
      current.filter((member) => hasMentionToken(value, member.name)),
    );
    const match = /(?:^|\s)@([\w-]*)$/.exec(value);
    setMentionQuery(match ? (match[1] ?? "") : null);
  }

  function insertMention(member: { botId: string; name: string }) {
    setDraft((current) => current.replace(/@([\w-]*)$/, `@${member.name} `));
    if (member.botId !== "everyone") {
      setSelectedMentions((current) =>
        current.some((selected) => selected.botId === member.botId)
          ? current
          : [...current, member],
      );
    }
    setMentionQuery(null);
  }

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || !mentionMembers?.length) return [];
    const query = mentionQuery.toLowerCase();
    const options = mentionMembers.filter((member) => member.name.toLowerCase().startsWith(query));
    if ("everyone".startsWith(query)) {
      options.unshift({ botId: "everyone", name: "everyone" });
    }
    return options.slice(0, 8);
  }, [mentionMembers, mentionQuery]);

  function send() {
    if (!canSend || sending || disabled) return;
    const text = draft;
    setDraft("");
    setMentionQuery(null);
    const mentions = selectedMentions.map((member) => member.botId);
    setSelectedMentions([]);
    void onSend(text, mentions);
  }

  return (
    <div className="px-3 pb-4 pt-3 md:px-6 md:pb-6">
      {sendError || dictationError ? (
        <div className="mb-3 rounded-[14px] border border-[#5A2A2A] bg-[#2A1717] px-4 py-2 text-[13px] text-[#F1A8A8]">
          {sendError ?? dictationError}
        </div>
      ) : null}
      {replyTarget ? (
        <div className="mb-3 flex items-start justify-between gap-3 rounded-[14px] border border-[#26262A] bg-[#17171A] px-4 py-2 text-[13px] text-[#C9C9CE]">
          <div className="min-w-0">
            <div className="text-[#85858A]">Replying to</div>
            <div className="truncate">{previewMessageText(replyTarget)}</div>
          </div>
          <button
            type="button"
            aria-label="Cancel reply"
            onClick={onClearReply}
            className="text-[#85858A]"
          >
            ✕
          </button>
        </div>
      ) : null}
      {attachmentNotice ? (
        <div className="mb-3 rounded-[14px] border border-[#3A3A20] bg-[#232316] px-4 py-2 text-[13px] text-[#D6CFA0]">
          {attachmentNotice}
        </div>
      ) : null}
      {pendingAttachments.length ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {pendingAttachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex items-center gap-2 rounded-full border border-[#26262A] bg-[#17171A] px-3 py-1.5 text-[13px] text-[#C9C9CE]"
            >
              {attachment.previewUrl ? (
                <img
                  src={attachment.previewUrl}
                  alt={attachment.file.name}
                  className="h-8 w-8 rounded object-cover"
                />
              ) : (
                <Paperclip size={14} strokeWidth={1.8} />
              )}
              <span className="max-w-[180px] truncate">{attachment.file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${attachment.file.name}`}
                onClick={() => onRemoveAttachment(attachment)}
                className="text-[#85858A] hover:text-[#ECECEE]"
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {mentionOptions.length ? (
        <div className="mb-2 overflow-hidden rounded-[14px] border border-[#26262A] bg-[#17171A]">
          {mentionOptions.map((member) => (
            <button
              key={member.botId}
              type="button"
              onClick={() => insertMention(member)}
              className="block w-full px-4 py-2 text-left text-[14px] text-[#ECECEE] hover:bg-[#1F1F22]"
            >
              @{member.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-3.5 rounded-full border border-[#202023] bg-[#131315] py-[9px] pr-2.5 pl-3">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          className="hidden"
          onChange={(event) => void onAttachmentPick(event.target.files)}
        />
        <button
          type="button"
          aria-label="Attach file"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full border border-[#26262A] text-[#9A9AA0] disabled:opacity-40"
        >
          <Plus size={17} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          aria-label={dictating ? "Stop dictation" : "Dictate"}
          onMouseDown={(event) => {
            event.preventDefault();
            onDictateStart((text) => setDraft((current) => `${current} ${text}`.trim()));
          }}
          onMouseUp={onDictateStop}
          onMouseLeave={() => {
            if (dictating) onDictateStop();
          }}
          onTouchStart={(event) => {
            event.preventDefault();
            onDictateStart((text) => setDraft((current) => `${current} ${text}`.trim()));
          }}
          onTouchEnd={onDictateStop}
          className={`grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full border ${
            dictating
              ? "border-[#4ECB71] bg-[rgba(48,162,75,.16)] text-[#4ECB71]"
              : "border-[#26262A] text-[#9A9AA0]"
          }`}
          title={transcribe ? "Hold to talk" : "Hold to talk (on-device dictation)"}
        >
          <Mic size={16} strokeWidth={1.8} />
        </button>
        <input
          value={draft}
          onChange={(event) => updateDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          disabled={disabled}
          placeholder={activeName ? `Message ${activeName}` : "Message…"}
          aria-label={activeName ? `Message ${activeName}` : "Message"}
          name="chat-message"
          autoComplete="off"
          className="flex-1 bg-transparent text-[15.5px] text-[#E9E9EA] outline-none disabled:opacity-40"
        />
        {running ? (
          <button
            type="button"
            aria-label="Stop"
            onClick={() => void onStop()}
            className="grid h-9 w-9 place-items-center rounded-full bg-[#F1F1EF] text-[#17171A]"
          >
            <Square size={12} strokeWidth={0} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            disabled={sending || !canSend || disabled}
            onClick={send}
            className="grid h-9 w-9 place-items-center rounded-full bg-[#F1F1EF] text-[#17171A] disabled:opacity-50"
          >
            <ArrowUp size={18} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
});

function previewMessageText(message: ThreadMessage): string {
  const text = message.blocks
    .map((block) => (block.kind === "text" ? block.text : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
  if (text) return text;
  if (message.blocks.some((block) => block.kind === "image" || block.kind === "file")) {
    return "Attachment";
  }
  return "Message";
}

function firstThreadRoute(
  bots: readonly Pick<Bot, "id">[],
  groups: readonly Pick<Group, "id">[],
): string {
  if (bots[0]) return `/app/${bots[0].id}`;
  if (groups[0]) return `/app/g/${groups[0].id}`;
  return "/app";
}

function applyThreadEvent(
  event: ProductEvent,
  setSnapshot: Dispatch<SetStateAction<ThreadSnapshot | null>>,
  setComputer: Dispatch<SetStateAction<ComputerStatus | null>>,
) {
  if (isThreadSnapshotEvent(event)) {
    setSnapshot((prev) => reduceThreadSnapshot(prev, event));
  }
  if (isComputerStatusEvent(event)) {
    setComputer((prev) => reduceComputerStatus(prev, event));
  }
}

function ToolSteps({
  steps,
  currentIndex,
}: {
  steps: Extract<ThreadMessage["blocks"][number], { kind: "steps" }>["steps"];
  currentIndex?: number;
}) {
  return (
    <div className="space-y-1.5">
      {steps.map((step, index) => {
        const isCurrent = index === currentIndex;
        return (
          <div key={index} className="flex items-center gap-2">
            <span
              className="text-[13px]"
              style={{
                color: isCurrent ? "#F5A03C" : "#4ECB71",
                animation: isCurrent ? "rkPulse 1.2s ease-in-out infinite" : undefined,
              }}
            >
              {isCurrent ? "◷" : "✓"}
            </span>
            <span
              className="truncate text-[14px]"
              style={{ color: isCurrent ? "#DFDFE2" : "#85858A" }}
            >
              {step.label}
              {step.count > 1 ? ` ×${step.count}` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const MessageView = memo(function MessageView({
  artifactTarget,
  canAnswer,
  message,
  onAnswer,
  onOpenBot,
  speakerName,
  memberName,
  replyPreview,
  onRefresh,
  onAddRoutine,
  voiceReady,
  speaking,
  onSpeak,
}: {
  artifactTarget: ArtifactTarget;
  canAnswer: boolean;
  message: ThreadMessage;
  onAnswer: (message: ThreadMessage, text: string) => Promise<void>;
  onOpenBot: (botId: string) => void;
  speakerName?: string;
  memberName?: (botId: string | undefined) => string | undefined;
  replyPreview?: ThreadMessage;
  onRefresh: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speaking: boolean;
  onSpeak: () => void;
}) {
  const isNarration =
    message.role === "bot" &&
    message.blocks.length > 0 &&
    message.blocks.every(
      (block) => block.kind === "text" || block.kind === "progress" || block.kind === "steps",
    );
  const isLive = message.id.startsWith("progress:");
  const messageContext = (
    <>
      {speakerName ? (
        <div className="mb-1 text-[12.5px] font-medium text-[#85858A]">{speakerName}</div>
      ) : null}
      {replyPreview ? (
        <div className="mb-2 max-w-[74%] rounded-[14px] border border-[#26262A] bg-[#131315] px-3 py-2 text-[12.5px] text-[#85858A]">
          {previewMessageText(replyPreview)}
        </div>
      ) : null}
    </>
  );
  if (isNarration) {
    return (
      <>
        {messageContext}
        <div className="flex justify-start">
          <div className="max-w-[74%] space-y-2.5 rounded-[20px] bg-[#1A1A1D] px-[18px] py-3 text-[15.5px] leading-[1.5] text-[#DFDFE2]">
            {message.blocks.map((block, i) => {
              if (block.kind === "steps") {
                const isCurrentBlock = isLive && i === message.blocks.length - 1;
                return (
                  <ToolSteps
                    key={i}
                    steps={block.steps}
                    currentIndex={isCurrentBlock ? block.steps.length - 1 : undefined}
                  />
                );
              }
              if (block.kind === "text" || block.kind === "progress") {
                return (
                  <div key={i}>
                    <ChatMarkdown streaming={block.kind === "progress"}>{block.text}</ChatMarkdown>
                  </div>
                );
              }
              return null;
            })}
            {!isLive && voiceReady && message.blocks.some((block) => block.kind === "text") ? (
              <button
                type="button"
                aria-label={speaking ? "Stop speaking" : "Speak this reply"}
                onClick={onSpeak}
                className="text-[12px] text-[#85858A] hover:text-[#ECECEE]"
              >
                {speaking ? "Stop" : "Speak"}
              </button>
            ) : null}
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      {messageContext}
      {message.blocks.map((block, i) => {
        if (block.kind === "handoff") {
          const from = memberName?.(block.fromBotId) ?? "bot";
          const to = memberName?.(block.toBotId) ?? "bot";
          return (
            <div
              key={i}
              className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-[#85858A]"
            >
              <span>
                ↪ {to} ← {from}
              </span>
              <span>{block.text}</span>
            </div>
          );
        }
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
        if (block.kind === "steps") {
          return (
            <div key={i} className="flex justify-start">
              <div className="max-w-[74%] space-y-1.5 rounded-[20px] bg-[#1A1A1D] px-[18px] py-3">
                <ToolSteps
                  steps={block.steps}
                  currentIndex={isLive ? block.steps.length - 1 : undefined}
                />
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
          const removed = block.status === "deleted" || block.status === "archived";
          return (
            <button
              key={i}
              type="button"
              disabled={removed}
              onClick={() => onOpenBot(block.botId)}
              className="w-[min(340px,90%)] rounded-[18px] border border-[#232326] bg-[#17171A] px-[18px] py-4 text-left disabled:opacity-60"
            >
              <div className="flex items-center justify-between">
                <span className="text-[15px] font-medium text-[#ECECEE]">{block.name}</span>
                <span
                  className="rounded-full px-[11px] py-1 text-[13px]"
                  style={{
                    background: removed ? "rgba(230,87,7,.14)" : "rgba(48,162,75,.14)",
                    color: removed ? "#E65707" : "#4ECB71",
                  }}
                >
                  {block.status === "archived"
                    ? "archived"
                    : block.status === "deleted"
                      ? "deleted"
                      : "bot"}
                </span>
              </div>
              <div className="mt-2 text-[14.5px] leading-[1.5] text-[#A8A8AD]">
                {removed
                  ? block.status === "archived"
                    ? "Archived this bot. Its chat, memory, and files are preserved."
                    : "Removed this bot, including its chat, computer, and memory."
                  : block.title || "Opened its own thread. Tap to switch."}
              </div>
            </button>
          );
        }
        if (block.kind === "image") {
          return (
            <div
              key={i}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <ArtifactImage
                target={artifactTarget}
                artifactId={block.artifactId}
                name={block.name}
              />
            </div>
          );
        }
        if (block.kind === "file") {
          return (
            <div
              key={i}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <ArtifactFileCard
                target={artifactTarget}
                artifactId={block.artifactId}
                name={block.name}
                mimeType={block.mimeType}
                size={block.size}
              />
            </div>
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
                {voiceReady ? (
                  <button
                    type="button"
                    aria-label={speaking ? "Stop speaking" : "Speak this reply"}
                    onClick={onSpeak}
                    className="mt-2 text-[12px] text-[#85858A] hover:text-[#ECECEE]"
                  >
                    {speaking ? "Stop" : "Speak"}
                  </button>
                ) : null}
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
            <AskCard
              key={i}
              block={block}
              canAnswer={canAnswer}
              onAnswer={(text) => onAnswer(message, text)}
            />
          );
        }
        if (block.kind === "skill_draft") {
          return (
            <div key={i} className="flex justify-start">
              <SkillDraftCard block={block} onRefresh={onRefresh} onAddRoutine={onAddRoutine} />
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
});

type AskBlock = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;

function AskCard({
  block,
  canAnswer,
  onAnswer,
}: {
  block: AskBlock;
  canAnswer: boolean;
  onAnswer: (text: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submitAnswer(value: string) {
    const text = value.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      await onAnswer(text);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-[74%] rounded-[20px] border border-[#242428] bg-[#141417] px-5 py-[17px]">
      <div className="text-[15.5px] leading-[1.5] text-[#ECECEE]">
        <ChatMarkdown>{block.text}</ChatMarkdown>
      </div>
      {block.detail ? (
        <pre className="mt-3 rounded-xl bg-[#0E0E10] px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-[#85858A]">
          {block.detail}
        </pre>
      ) : null}
      {block.status === "answered" ? (
        <div className="mt-3.5 text-[13.5px] font-medium text-[#4ECB71]">
          {block.answer ? `Answered: ${block.answer}` : "Answered"}
        </div>
      ) : !canAnswer ? (
        <div className="mt-3.5 text-[13.5px] font-medium text-[#85858A]">No longer active</div>
      ) : editing ? (
        <form
          className="mt-3.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer(answer);
          }}
        >
          <input
            aria-label="Answer"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Type your answer"
            className="rounded-[11px] border border-[#303035] bg-[#0E0E10] px-3.5 py-2.5 text-[14.5px] text-[#ECECEE] outline-none focus:border-[#66666D]"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!answer.trim() || submitting}
              className="rounded-[11px] bg-[#F1F1EF] px-[17px] py-2 text-[14.5px] font-medium text-[#17171A] disabled:opacity-50"
            >
              {submitting ? "Sending…" : "Send answer"}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => {
                setAnswer("");
                setEditing(false);
              }}
              className="rounded-[11px] border border-[#26262A] px-[17px] py-2 text-[14.5px] text-[#C9C9CE] disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-3.5 flex gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submitAnswer("approved")}
            className="rounded-[11px] bg-[#F1F1EF] px-[17px] py-2 text-[14.5px] font-medium text-[#17171A] disabled:opacity-50"
          >
            {submitting ? "Sending…" : "Send it"}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => setEditing(true)}
            className="rounded-[11px] border border-[#26262A] px-[17px] py-2 text-[14.5px] text-[#C9C9CE] disabled:opacity-50"
          >
            Edit first
          </button>
        </div>
      )}
    </div>
  );
}

function ComputerModePicker({
  value,
  onChange,
}: {
  value: ComputerMode;
  onChange: (value: ComputerMode) => void;
}) {
  return (
    <div className="mt-4">
      <div className="text-[14px] text-[#85858A]">Computer</div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {(["team", "dedicated"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={value === mode}
            onClick={() => onChange(mode)}
            className={`rounded-[11px] border px-3.5 py-3 text-[14px] capitalize ${
              value === mode
                ? "border-[#6C6C70] bg-[#1A1A1D] text-[#ECECEE]"
                : "border-[#26262A] text-[#85858A]"
            }`}
          >
            {mode === "team" ? "Team" : "Private"}
          </button>
        ))}
      </div>
    </div>
  );
}

function CreateBotForm({
  onCreate,
  onCancel,
}: {
  onCreate: (input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
  }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-[#85858A]">New bot</span>
        <button type="button" onClick={onCancel}>
          <X size={16} strokeWidth={1.8} />
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
      <ComputerModePicker value={computerMode} onChange={setComputerMode} />
      <button
        type="button"
        disabled={!name.trim()}
        onClick={() => onCreate({ name, title, description, computerMode })}
        className="mt-5 rounded-[11px] bg-[#F1F1EF] px-4 py-2 text-[#17171A] disabled:opacity-40"
      >
        Create
      </button>
    </div>
  );
}

function BotSettings({
  bot,
  memoryProviderConfigured,
  onSave,
  onExport,
  onClear,
}: {
  bot: Bot;
  memoryProviderConfigured: boolean;
  onSave: (patch: {
    name?: string;
    title?: string;
    description?: string;
    instructions?: string;
    computerMode: ComputerMode;
    memoryScope?: "isolated" | "shared" | null;
    autoSpeak?: boolean;
    voiceId?: string | null;
  }) => Promise<void>;
  onExport: () => Promise<void>;
  onClear: () => void;
}) {
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [description, setDescription] = useState(bot.description);
  const [computerMode, setComputerMode] = useState(bot.computerMode);
  const [memoryScope, setMemoryScope] = useState(bot.memoryScope);
  const [autoSpeak, setAutoSpeak] = useState(bot.autoSpeak);
  const [voiceId, setVoiceId] = useState(bot.voiceId ?? "");
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void rpc.voice
      .voices({})
      .then(setVoices)
      .catch(() => setVoices([]));
  }, []);

  return (
    <div data-testid="bot-settings">
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
      <ComputerModePicker value={computerMode} onChange={setComputerMode} />
      {memoryProviderConfigured ? (
        <div className="mt-4 text-[14px] text-[#85858A]">
          Memory scope
          <div className="mt-2 flex gap-2">
            {(
              [
                { value: null, label: "Inherit default" },
                { value: "isolated" as const, label: "Isolated" },
                { value: "shared" as const, label: "Shared" },
              ] satisfies Array<{ value: "isolated" | "shared" | null; label: string }>
            ).map((option) => (
              <button
                key={option.label}
                type="button"
                aria-pressed={memoryScope === option.value}
                onClick={() => setMemoryScope(option.value)}
                className={`flex-1 rounded-[11px] border px-3 py-2 text-[13px] ${
                  memoryScope === option.value
                    ? "border-[#4A4A50] bg-[#1A1A1D] text-[#ECECEE]"
                    : "border-[#26262A] text-[#85858A]"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <label className="mt-5 flex cursor-pointer items-center gap-3 text-[14px] text-[#C9C9CE]">
        <input
          type="checkbox"
          checked={autoSpeak}
          onChange={(event) => setAutoSpeak(event.target.checked)}
        />
        Read replies aloud
      </label>
      {voices.length ? (
        <label className="mt-4 block text-[14px] text-[#85858A]">
          Voice
          <select
            value={voiceId}
            onChange={(event) => setVoiceId(event.target.value)}
            className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
          >
            <option value="">Account default</option>
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {error ? <p className="mt-2 text-[13px] text-[#E65707]">{error}</p> : null}
      <div className="mt-5 flex flex-col items-start gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            setError(null);
            void onSave({
              name,
              title,
              description,
              instructions: description,
              computerMode,
              memoryScope,
              autoSpeak,
              voiceId: voiceId || null,
            })
              .catch((err) => setError(err instanceof Error ? err.message : "Could not save"))
              .finally(() => setSaving(false));
          }}
          className="rounded-[11px] bg-[#F1F1EF] px-4 py-2 text-[#17171A] disabled:opacity-40"
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
        <button type="button" onClick={onClear} className="text-[14px] text-[#E65707]">
          Clear conversation
        </button>
      </div>
    </div>
  );
}

function NewBotSectionDialog({
  bot,
  onCancel,
  onConfirm,
}: {
  bot: Bot;
  onCancel: () => void;
  onConfirm: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, saving]);

  return (
    <div
      role="presentation"
      className="absolute inset-0 z-50 grid place-items-center bg-[rgba(4,4,5,.76)] px-5"
      onPointerDown={() => {
        if (!saving) onCancel();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-bot-section-title"
        className="w-full max-w-[420px] rounded-[18px] border border-[#343438] bg-[#1A1A1D] p-5 shadow-[0_24px_70px_rgba(0,0,0,.65)]"
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (!trimmed || saving) return;
          setSaving(true);
          setError(null);
          void onConfirm(trimmed).catch((err: unknown) => {
            setError(err instanceof Error ? err.message : "Could not create section");
            setSaving(false);
          });
        }}
      >
        <h2 id="new-bot-section-title" className="text-[17px] font-medium text-[#F1F1F2]">
          New section
        </h2>
        <p className="mt-2 text-[14px] leading-6 text-[#9A9AA0]">
          Create a section and move {bot.name} into it.
        </p>
        <label className="mt-4 block text-[13.5px] text-[#C9C9CE]">
          Name
          <input
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-2 w-full rounded-[11px] border border-[#343438] bg-[#101012] px-3.5 py-2.5 text-[14.5px] text-[#ECECEE] outline-none focus:border-[#66666D]"
          />
        </label>
        {error ? <p className="mt-3 text-[13.5px] text-[#FF5364]">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            disabled={saving}
            onClick={onCancel}
            className="rounded-[10px] px-3.5 py-2 text-[14px] text-[#C9C9CE] hover:bg-[#29292D] disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="rounded-[10px] bg-[#F1F1EF] px-3.5 py-2 text-[14px] font-medium text-[#17171A] disabled:opacity-40"
          >
            {saving ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ClearConversationDialog({
  bot,
  onCancel,
  onConfirm,
}: {
  bot: Bot;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !clearing) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearing, onCancel]);

  return (
    <div
      role="presentation"
      className="absolute inset-0 z-50 grid place-items-center bg-[rgba(4,4,5,.76)] px-5"
      onPointerDown={() => {
        if (!clearing) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="clear-conversation-title"
        aria-describedby="clear-conversation-description"
        className="w-full max-w-[420px] rounded-[18px] border border-[#343438] bg-[#1A1A1D] p-5 shadow-[0_24px_70px_rgba(0,0,0,.65)]"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h2 id="clear-conversation-title" className="text-[17px] font-medium text-[#F1F1F2]">
          Clear {bot.name}’s conversation?
        </h2>
        <p
          id="clear-conversation-description"
          className="mt-2 text-[14px] leading-6 text-[#9A9AA0]"
        >
          This permanently removes every message and stops current work. The bot, computer, memory,
          and routines are kept.
        </p>
        {error ? <p className="mt-3 text-[13.5px] text-[#FF5364]">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            disabled={clearing}
            onClick={onCancel}
            className="rounded-[10px] px-3.5 py-2 text-[14px] text-[#C9C9CE] hover:bg-[#29292D] disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={clearing}
            onClick={() => {
              setClearing(true);
              setError(null);
              void onConfirm().catch((err: unknown) => {
                setError(err instanceof Error ? err.message : "Could not clear conversation");
                setClearing(false);
              });
            }}
            className="rounded-[10px] bg-[#FF5364] px-3.5 py-2 text-[14px] font-medium text-white disabled:opacity-40"
          >
            {clearing ? "Clearing…" : "Clear"}
          </button>
        </div>
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
  onConfirm: (deleteMemories: boolean) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [deleteMemories, setDeleteMemories] = useState(false);
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
          Its conversation, files, and routines will be permanently deleted. Bots it created stay in
          your list.
        </p>
        <fieldset className="mt-4 space-y-2">
          <legend className="mb-2 text-[13.5px] text-[#C9C9CE]">What about its memories?</legend>
          <label className="flex cursor-pointer gap-3 rounded-[11px] border border-[#343438] p-3">
            <input
              type="radio"
              name="delete-memory"
              checked={!deleteMemories}
              onChange={() => setDeleteMemories(false)}
            />
            <span>
              <span className="block text-[14px] text-[#ECECEE]">Keep memories</span>
              <span className="mt-0.5 block text-[12.5px] text-[#85858A]">
                Move them to your shared memory.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer gap-3 rounded-[11px] border border-[#343438] p-3">
            <input
              type="radio"
              name="delete-memory"
              checked={deleteMemories}
              onChange={() => setDeleteMemories(true)}
            />
            <span>
              <span className="block text-[14px] text-[#ECECEE]">Delete memories too</span>
              <span className="mt-0.5 block text-[12.5px] text-[#85858A]">
                This cannot be undone.
              </span>
            </span>
          </label>
        </fieldset>
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
              void onConfirm(deleteMemories).catch((err: unknown) => {
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

function DeleteRoutineDialog({
  routine,
  onCancel,
  onConfirm,
}: {
  routine: Routine;
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
        aria-labelledby="delete-routine-title"
        aria-describedby="delete-routine-description"
        className="w-full max-w-[420px] rounded-[18px] border border-[#343438] bg-[#1A1A1D] p-5 shadow-[0_24px_70px_rgba(0,0,0,.65)]"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h2 id="delete-routine-title" className="text-[17px] font-medium text-[#F1F1F2]">
          Delete {routine.name}?
        </h2>
        <p id="delete-routine-description" className="mt-2 text-[14px] leading-6 text-[#9A9AA0]">
          This cannot be undone.
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
                setError(err instanceof Error ? err.message : "Could not delete routine");
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
  label: string,
) {
  if (state === "booting" || booting) return "Booting live desktop…";
  if (state === "running") return label;
  if (state === "suspended") return "Computer is asleep — take control to wake it";
  if (state === "error") return "Computer failed to boot";
  return "Computer is stopped";
}

function computerLabel(mode: ComputerStatus["mode"] | undefined, botName: string) {
  return mode === "dedicated" ? `${botName}’s computer` : "Team Computer";
}

function ArtifactImage({
  target,
  artifactId,
  name,
}: {
  target: ArtifactTarget;
  artifactId: string;
  name: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const targetBotId = "botId" in target ? target.botId : undefined;
  const targetGroupId = "groupId" in target ? target.groupId : undefined;

  useEffect(() => {
    const element = container.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setSrc(null);
    void rpc.artifacts
      .get(
        targetBotId
          ? { botId: targetBotId, artifactId }
          : { groupId: targetGroupId ?? "", artifactId },
      )
      .then((artifact) => {
        const bytes = decodeArtifactBase64(artifact.contentBase64);
        objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: artifact.mimeType }),
        );
        if (cancelled) URL.revokeObjectURL(objectUrl);
        else setSrc(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifactId, targetBotId, targetGroupId, visible]);

  return (
    <div ref={container}>
      {src ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="max-w-[240px] overflow-hidden rounded-[20px]"
        >
          <img src={src} alt={name} className="max-h-48 w-full object-cover" />
        </button>
      ) : (
        <div className="rounded-[20px] border border-[#26262A] bg-[#17171A] px-4 py-3 text-[14px] text-[#85858A]">
          {name}
        </div>
      )}
      {open && src ? (
        <button
          type="button"
          aria-label="Close image preview"
          className="fixed inset-0 z-50 grid place-items-center bg-[rgba(4,4,5,.82)] p-6"
          onClick={() => setOpen(false)}
        >
          <img
            src={src}
            alt={name}
            className="max-h-[85vh] max-w-[90vw] rounded-[12px] object-contain"
          />
        </button>
      ) : null}
    </div>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.includes(",") ? (result.split(",")[1] ?? "") : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}
