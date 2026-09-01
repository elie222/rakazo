import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type {
  AgentSkillCatalogEntry,
  Bot,
  BotSection,
  ComputerMode,
  ComputerReleaseReason,
  ComputerStatus,
  Connection,
  ConnectionCatalogItem,
  Group,
  Me,
  MessageBlock,
  ModelCatalogEntry,
  ModelCredential,
  ProductEvent,
  Routine,
  SearchHit,
  Space,
  SpaceMemoryConfig,
  TaughtSkill,
  ThinkingLevel,
  ThreadMessage,
  ThreadSnapshot,
  VoiceInfo,
  VoiceStatus,
} from "@rakazo/contracts";
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  canReactToThreadMessage,
  normalizeCreateBotProfile,
} from "@rakazo/contracts";
import {
  abortableDelay,
  attachmentsForThread,
  buildComposerMentionOptions,
  type ComposerMention,
  clampMentionHighlightIndex,
  cronFromPreset,
  groupBotsForSidebar,
  inferAttachmentMimeType,
  isActive,
  isPeerReceiptBlocks,
  isRunTerminalEvent,
  latestAnswerableAskMessageId,
  mentionChipKey,
  reorderBotTo,
  resolveComposerSendPlan,
  resolveMentionPickerKey,
  SLASH_ACTIONS,
  type SlashActionId,
  searchHitThreadTarget,
  serializeComposerPrompt,
  speechFromBlocks,
  toolActivityLabel,
  truncateSlashDescription,
  userVisibleMessages,
} from "@rakazo/core";
import {
  AvatarStyleProvider,
  BotAvatar,
  Button,
  GroupAvatar,
  type GroupAvatarMember,
} from "@rakazo/ui-web";
import {
  ArrowDown,
  ArrowUp,
  Bell,
  Box,
  ChevronDown,
  Clock,
  Copy,
  Cpu,
  Gauge,
  Lock,
  LogOut,
  Menu,
  Mic,
  Monitor,
  Paperclip,
  Phone,
  Plus,
  Puzzle,
  Reply,
  Settings,
  Square,
  ThumbsUp,
  Volume2,
  X,
} from "lucide-react";
import {
  type DragEvent,
  lazy,
  type MutableRefObject,
  memo,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArtifactFileCard } from "../components/ArtifactFileCard";
import { AskCard } from "../components/AskCard";
import {
  ActiveBotGlyph,
  CollaborationMarker,
} from "../components/beautiful-ui/CollaborationMarker";
import { BuiButton, BuiCard, SuccessPop } from "../components/beautiful-ui/primitives";
import { ComputerMaintenanceActions } from "../components/ComputerMaintenanceActions";
import {
  ComputersUnavailableHint,
  computersAreUnavailable,
} from "../components/ComputersUnavailableHint";
import { MessageHoverMetadata } from "../components/MessageHoverMetadata";
import { ToolActivityDisclosure, ToolSteps } from "../components/ToolActivityDisclosure";
import { SkillDraftCard } from "../components/teach/SkillDraftCard";
import { TeachCaptureOverlay } from "../components/teach/TeachCaptureOverlay";
import { TeachComputerSection } from "../components/teach/TeachComputerSection";
import { TeachRecordingChrome, TeachStopButton } from "../components/teach/TeachRecordingChrome";
import { readActivityMode, writeActivityMode } from "../lib/activity-mode";
import { type ArtifactTarget, decodeArtifactBase64 } from "../lib/artifact-open";
import { authClient } from "../lib/auth";
import { takeInitialBootstrap } from "../lib/bootstrap";
import {
  deliverBrowserNotification as deliverNativeBrowserNotification,
  requestBrowserNotificationPermission,
  shouldNotifyBrowser,
} from "../lib/browser-notifications";
import { chartViewport } from "../lib/chart-viewport";
import { dictation } from "../lib/dictation";
import { localTimezone } from "../lib/local-timezone";
import { connectMcpOauth } from "../lib/mcp-connect";
import { copyableMessageText } from "../lib/message-text";
import { providerLabel } from "../lib/messaging";
import { isFileDrag, revokePendingAttachmentPreviews } from "../lib/pending-attachments";
import { markAfterPaint, markOnce } from "../lib/performance";
import { clearSpaceSelection, rpc, selectedSpaceId, selectSpace } from "../lib/rpc";
import { readSeenRunErrorIds, rememberSeenRunErrorId } from "../lib/run-error-storage";
import {
  activeThreadRuns,
  clearActiveThreadRuns,
  computerPanelAutoBoot,
  computerPanelAutoUsesBoot,
  computerTakeoverBlocked,
  isComputerStatusEvent,
  isThreadSnapshotEvent,
  prependThreadMessagePage,
  reconcileRefreshedThread,
  reduceComputerStatus,
  reduceThreadSnapshot,
  threadRunError,
  userHoldsComputerControl,
} from "../lib/thread-events";
import {
  transcriptCanSnapAfterFrame,
  transcriptIsNearEnd,
  transcriptMovedDown,
} from "../lib/transcript-scroll";
import { speaker } from "../lib/tts";
import { ActivityList } from "./ActivityList";
import type { ContextMenuPosition } from "./BotContextMenu";
import { CreateGroupForm, GroupSettings, memberName } from "./GroupPanel";
import { HostComputerPrompt } from "./HostComputerPrompt";
import {
  draftFromRoutine,
  emptyRoutineDraft,
  type RoutineDraftState,
  RoutineEditor,
  RoutineListHeader,
  RoutineListRow,
  routineNeedsOneShotArm,
} from "./RoutineEditor";
import { SpaceSearchResults } from "./SpaceSearch";
import { WindowChrome } from "./WindowChrome";

const BotContextMenu = lazy(() =>
  import("./BotContextMenu").then((module) => ({ default: module.BotContextMenu })),
);
const AccountSettingsOverlay = lazy(() =>
  import("./AccountSettingsOverlay").then((module) => ({
    default: module.AccountSettingsOverlay,
  })),
);
const MessagingSettingsOverlay = lazy(() =>
  import("./MessagingSettingsOverlay").then((module) => ({
    default: module.MessagingSettingsOverlay,
  })),
);
const ModelSettingsOverlay = lazy(() =>
  import("./ModelSettingsOverlay").then((module) => ({ default: module.ModelSettingsOverlay })),
);
const PeerMessagesOverlay = lazy(() =>
  import("./PeerMessagesOverlay").then((module) => ({ default: module.PeerMessagesOverlay })),
);
const PluginsOverlay = lazy(() =>
  import("./PluginsOverlay").then((module) => ({ default: module.PluginsOverlay })),
);
const McpServersOverlay = lazy(() =>
  import("./McpServersOverlay").then((module) => ({ default: module.McpServersOverlay })),
);
const MemorySettingsOverlay = lazy(() =>
  import("./MemorySettingsOverlay").then((module) => ({
    default: module.MemorySettingsOverlay,
  })),
);
const VoiceSettingsOverlay = lazy(() =>
  import("./VoiceSettingsOverlay").then((module) => ({ default: module.VoiceSettingsOverlay })),
);
const CallView = lazy(() => import("./CallView").then((module) => ({ default: module.CallView })));
const ScratchpadSection = lazy(() =>
  import("./ScratchpadSection").then((module) => ({ default: module.ScratchpadSection })),
);

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

type PendingBrowserNotification = {
  event: Pick<ProductEvent, "id" | "type" | "threadId" | "botId" | "payload">;
  botId: string;
  botName: string;
  groupNotification: boolean;
};

const ATTACHMENT_ACCEPT = ATTACHMENT_ALLOWED_MIME_TYPES.join(",");
const THREAD_SNAPSHOT_TIMEOUT_MS = 2_000;

function threadSnapshotSignal(parent: AbortSignal): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(THREAD_SNAPSHOT_TIMEOUT_MS)]);
}

function collapsedSidebarSectionsStorageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `rakazo:collapsed-sidebar-sections:${userId}`;
}

function readCollapsedSidebarSections(userId: string | null | undefined): Set<string> {
  const storageKey = collapsedSidebarSectionsStorageKey(userId);
  if (!storageKey) return new Set();
  try {
    const value = window.localStorage.getItem(storageKey);
    const keys: unknown = value ? JSON.parse(value) : [];
    return new Set(
      Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function ShellPage() {
  const { t } = useLingui();
  const { botId, groupId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Mirrors searchParams for effects that only need to read it once on run,
  // not re-run on every unrelated query-param change (e.g. the SSE subscribe
  // effect below, which should only restart when the active bot changes).
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const [groups, setGroups] = useState<Group[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const botsRef = useRef(bots);
  botsRef.current = bots;
  const botOrderEpochRef = useRef(0);
  const pendingBotOrderRef = useRef<string[] | null>(null);
  const savingBotOrderRef = useRef(false);
  const [botSections, setBotSections] = useState<BotSection[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [archivedBots, setArchivedBots] = useState<Bot[]>([]);
  const [archivedGroups, setArchivedGroups] = useState<Group[]>([]);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState(() => new Set<string>());

  useEffect(() => {
    setCollapsedSidebarSections(readCollapsedSidebarSections(userId));
  }, [userId]);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const snapshotRef = useRef<ThreadSnapshot | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [replyTarget, setReplyTarget] = useState<ThreadMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [peerConversation, setPeerConversation] = useState<{
    peerBotId: string;
    peerBotName: string;
  } | null>(null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routinesBotId, setRoutinesBotId] = useState<string | null>(null);
  const [taughtSkills, setTaughtSkills] = useState<TaughtSkill[]>([]);
  const [taughtSkillsBotId, setTaughtSkillsBotId] = useState<string | null>(null);
  const [agentSkills, setAgentSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [mentionRoutines, setMentionRoutines] = useState<Array<Routine & { botName?: string }>>([]);
  const [mentionConnectors, setMentionConnectors] = useState<
    Array<{
      id: string;
      name: string;
      authStatus: "connected" | "needs_auth";
      connectionId?: string;
    }>
  >([]);
  const [teachBusy, setTeachBusy] = useState(false);
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const computerRef = useRef<ComputerStatus | null>(null);
  const threadRefreshEpoch = useRef(0);
  const groupRefreshEpoch = useRef(0);
  const botsRefreshEpoch = useRef(0);
  const botsRefreshApplied = useRef(0);
  const archivedBotsRefreshEpoch = useRef(0);
  const botsRefreshInFlight = useRef(0);
  // Last-known computer/screen per bot, so switching back to an already-seen
  // bot paints its computer pane instantly instead of blanking it while the
  // thread + screen RPCs round-trip again (see refreshThread / refreshComputerScreen).
  const computerCacheRef = useRef(
    new Map<string, { computer: ComputerStatus | null; screenUrl: string | null }>(),
  );
  // Caps computerCacheRef so a long session that opens many distinct bots
  // over time doesn't accumulate one entry per bot forever. Re-inserting on
  // every update keeps Map iteration order as least-recently-used first, so
  // eviction drops the bot that's been out of view longest.
  const COMPUTER_CACHE_LIMIT = 20;

  function cacheComputerFor(
    botId: string,
    patch: Partial<{ computer: ComputerStatus | null; screenUrl: string | null }>,
  ) {
    const cache = computerCacheRef.current;
    const prev = cache.get(botId) ?? { computer: null, screenUrl: null };
    cache.delete(botId);
    cache.set(botId, { ...prev, ...patch });
    if (cache.size > COMPUTER_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  function commitSnapshot(next: ThreadSnapshot | null) {
    snapshotRef.current = next;
    setSnapshot(next);
  }

  function commitComputer(next: ComputerStatus | null) {
    computerRef.current = next;
    setComputer(next);
  }

  function updateSnapshot(update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) {
    commitSnapshot(update(snapshotRef.current));
  }
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [messagingSettingsOpen, setMessagingSettingsOpen] = useState(false);
  const [messagingSurfaceEnabled, setMessagingSurfaceEnabled] = useState(false);
  const [accountSettingsFocusUsage, setAccountSettingsFocusUsage] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [memorySettingsOpen, setMemorySettingsOpen] = useState(false);
  const [memoryProviderConfig, setMemoryProviderConfig] = useState<
    SpaceMemoryConfig | null | undefined
  >(undefined);
  const memoryProviderConfigRevision = useRef(0);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [dictating, setDictating] = useState(false);
  const [dictationError, setDictationError] = useState<string | null>(null);
  const [dismissedRunErrorIds, setDismissedRunErrorIds] =
    useState<ReadonlySet<string>>(readSeenRunErrorIds);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [draggedBotId, setDraggedBotId] = useState<string | null>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    function closeMobileSidebar() {
      if (desktop.matches) setMobileSidebarOpen(false);
    }
    closeMobileSidebar();
    desktop.addEventListener("change", closeMobileSidebar);
    return () => desktop.removeEventListener("change", closeMobileSidebar);
  }, []);
  const [activityMode, setActivityMode] = useState(readActivityMode);
  const toggleActivityMode = useCallback(() => {
    setActivityMode((on) => {
      const next = !on;
      writeActivityMode(next);
      return next;
    });
  }, []);
  const [botMenu, setBotMenu] = useState<{
    kind: "bot" | "group";
    id: string;
    position: ContextMenuPosition;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<Group | null>(null);
  const [clearTarget, setClearTarget] = useState<
    { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group } | null
  >(null);
  const [newSectionTarget, setNewSectionTarget] = useState<
    { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group } | null
  >(null);
  const [booting, setBooting] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [initialBotsLoaded, setInitialBotsLoaded] = useState(false);
  const [bootstrapMe, setBootstrapMe] = useState<Me | null>();
  const [routineDraft, setRoutineDraft] = useState<RoutineDraftState>(emptyRoutineDraft());
  const [routineWebhookSecret, setRoutineWebhookSecret] = useState<string | null>(null);
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null);
  const [deleteRoutineTarget, setDeleteRoutineTarget] = useState<Routine | null>(null);
  const [savingRoutine, setSavingRoutine] = useState(false);
  const [runningRoutine, setRunningRoutine] = useState(false);
  const [routineError, setRoutineError] = useState<string | null>(null);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);
  const [computerError, setComputerError] = useState<string | null>(null);
  useEffect(() => {
    if (!session.data?.user) return;
    let cancelled = false;
    void rpc.messaging
      .status()
      .then((status) => {
        if (!cancelled) setMessagingSurfaceEnabled(status.enabled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session.data?.user]);
  const [usage, setUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
    runs: number;
  } | null>(null);
  const autoBooted = useRef<string | null>(null);
  const routineSavePending = useRef(false);
  const routineSaveRequest = useRef(0);
  const routineRunPending = useRef(false);
  const bootstrappedThread = useRef<ThreadSnapshot | null>(null);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const jumpGeneration = useRef(0);
  const initiallyScrolledThread = useRef<string | null>(null);
  const messageScroll = useRef<HTMLDivElement>(null);
  const pinnedAroundRef = useRef<{
    botId?: string;
    groupId?: string;
    messageId: string;
    threadId: string;
    messages: ThreadMessage[];
    olderCursor: number | null;
  } | null>(null);
  const manuallyUnread = useRef(new Set<string>());
  const readVisibleGroups = useRef(new Set<string>());
  const notifiedBrowserEvents = useRef(new Set<string>());
  const pendingBrowserNotifications = useRef(new Map<string, PendingBrowserNotification>());
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
  const contextBot =
    botMenu?.kind === "bot" ? bots.find((bot) => bot.id === botMenu.id) : undefined;
  const contextGroup =
    botMenu?.kind === "group" ? groups.find((group) => group.id === botMenu.id) : undefined;
  const contextChat = contextBot ?? contextGroup;
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
  const deliverBrowserNotification = useCallback((pending: PendingBrowserNotification): boolean => {
    const currentBot = botsRef.current.find((bot) => bot.id === pending.botId);
    if (!currentBot || typeof Notification === "undefined") return true;
    const result = deliverNativeBrowserNotification(
      pending.event,
      currentBot.name || pending.botName,
      {
        enabled: pending.groupNotification || currentBot.notifyOnFinish,
        pageVisible: document.visibilityState === "visible",
        windowFocused: document.hasFocus(),
        permission: Notification.permission,
        notifiedEventIds: notifiedBrowserEvents.current,
        show: (title, body, tag) => new Notification(title, { body, tag }),
      },
    );
    return result !== "pending";
  }, []);
  const flushPendingBrowserNotifications = useCallback(() => {
    for (const [threadId, pending] of pendingBrowserNotifications.current) {
      if (deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(threadId);
      }
    }
  }, [deliverBrowserNotification]);
  const notifyBrowserForEvent = useCallback(
    (
      event: Pick<ProductEvent, "id" | "type" | "threadId" | "seq" | "botId" | "payload">,
      subscribedThreadId: string | undefined,
      initialCursor: number,
      streamReady: boolean,
      botName: string,
      enabled: boolean,
      groupNotification: boolean,
    ) => {
      const botId = event.botId;
      if (typeof botId !== "string") return;
      const eligible = shouldNotifyBrowser(event, {
        subscribedThreadId: subscribedThreadId ?? "",
        initialCursor,
        streamReady,
        pageVisible: document.visibilityState === "visible",
        windowFocused: document.hasFocus(),
        permission: "granted",
        notifiedEventIds: notifiedBrowserEvents.current,
      });
      if (!eligible || !enabled) return;
      const pending = {
        event,
        botId,
        botName,
        groupNotification,
      } satisfies PendingBrowserNotification;
      if (typeof Notification === "undefined" || Notification.permission === "denied") return;
      if (Notification.permission === "default") {
        pendingBrowserNotifications.current.set(event.threadId, pending);
        return;
      }
      if (deliverBrowserNotification(pending)) {
        pendingBrowserNotifications.current.delete(event.threadId);
      } else {
        pendingBrowserNotifications.current.set(event.threadId, pending);
      }
    },
    [deliverBrowserNotification],
  );

  const refreshBots = useCallback(
    async (includeArchived = false, replaceBotOrder = false) => {
      markOnce("rk:renderer:bots-request-start");
      const request = ++botsRefreshEpoch.current;
      const botOrderEpoch = botOrderEpochRef.current;
      const preserveBotOrder = savingBotOrderRef.current || pendingBotOrderRef.current !== null;
      const archivedRequest = includeArchived ? ++archivedBotsRefreshEpoch.current : null;
      botsRefreshInFlight.current += 1;
      try {
        const [navigation, archived, archivedGroupList] = await Promise.all([
          rpc.spaces.list(),
          includeArchived ? rpc.bots.listArchived() : Promise.resolve(null),
          includeArchived ? rpc.groups.listArchived() : Promise.resolve(null),
        ]);
        const { bots: list, botSections: sections, groups: groupList } = navigation.current;
        markOnce("rk:renderer:bots-response");
        const botsFresh = request === botsRefreshEpoch.current;
        const archivedFresh =
          archivedRequest != null && archivedRequest === archivedBotsRefreshEpoch.current;
        // A newer non-archived refresh can win the bots epoch while an older
        // includeArchived request still owns archivedBotsRefreshEpoch — apply
        // whichever slices are still current.
        if (!botsFresh && !archivedFresh) return;
        if (archivedFresh && archived) setArchivedBots(archived);
        if (archivedFresh && archivedGroupList) setArchivedGroups(archivedGroupList);
        if (!botsFresh) return;
        if (
          botOrderEpoch === botOrderEpochRef.current &&
          (replaceBotOrder || (!preserveBotOrder && !savingBotOrderRef.current))
        ) {
          setBots(list);
        }
        setBotSections(sections);
        setGroups(groupList);
        setSpaces(navigation.spaces);
        setInitialBotsLoaded(true);
        botsRefreshApplied.current = request;
        if (
          includeArchived &&
          list.length === 0 &&
          archived?.length === 0 &&
          groupList.length === 0 &&
          archivedGroupList?.length === 0
        ) {
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
      } finally {
        botsRefreshInFlight.current -= 1;
      }
    },
    [navigate],
  );

  function snapTranscriptToEndAfterFrame() {
    const queuedElement = messageScroll.current;
    if (!queuedElement) return;
    const queuedScrollTop = queuedElement.scrollTop;
    window.requestAnimationFrame(() => {
      const element = messageScroll.current;
      if (transcriptCanSnapAfterFrame(element, queuedElement, queuedScrollTop)) {
        queuedElement.scrollTop = queuedElement.scrollHeight;
      }
    });
  }

  async function refreshGroupThread(id: string, signal?: AbortSignal) {
    const scrollElement = messageScroll.current;
    const stickToEnd = !scrollElement || transcriptIsNearEnd(scrollElement);
    markOnce("rk:renderer:thread-request-start");
    const request = ++groupRefreshEpoch.current;
    const snap = await rpc.threads.get({ groupId: id }, signal ? { signal } : undefined);
    markOnce("rk:renderer:thread-response");
    if (activeGroupId.current !== id || request !== groupRefreshEpoch.current) return snap;
    const reconciled = reconcileRefreshedThread(
      snapshotRef.current,
      snap,
      computerRef.current,
      expandedHistoryThread.current === snap.threadId,
    );
    commitSnapshot(reconciled.snapshot);
    commitComputer(null);
    setRoutines([]);
    setRoutinesBotId(null);
    // Keep the search-jump viewport; expandedHistoryThread merge still accepts live messages.
    if (
      stickToEnd &&
      (!scrollElement || transcriptIsNearEnd(scrollElement)) &&
      expandedHistoryThread.current !== snap.threadId
    ) {
      snapTranscriptToEndAfterFrame();
    }
    return snap;
  }

  async function refreshThread(id: string, signal?: AbortSignal) {
    const scrollElement = messageScroll.current;
    const stickToEnd = !scrollElement || transcriptIsNearEnd(scrollElement);
    markOnce("rk:renderer:thread-request-start");
    const epoch = historyEpoch.current;
    const request = ++threadRefreshEpoch.current;
    // Apply threads.get as soon as it returns so stop/takeover status is not held behind
    // routines/skills/screen fetches (progress can advance the cursor meanwhile).
    const snap = await rpc.threads.get({ botId: id }, signal ? { signal } : undefined);
    markOnce("rk:renderer:thread-response");
    if (
      activeBotId.current !== id ||
      epoch !== historyEpoch.current ||
      request !== threadRefreshEpoch.current
    ) {
      return snap;
    }
    const reconciled = reconcileRefreshedThread(
      snapshotRef.current,
      snap,
      computerRef.current,
      expandedHistoryThread.current === snap.threadId,
    );
    commitSnapshot(reconciled.snapshot);
    commitComputer(reconciled.computer);
    cacheComputerFor(id, { computer: reconciled.computer });
    if (
      stickToEnd &&
      (!scrollElement || transcriptIsNearEnd(scrollElement)) &&
      expandedHistoryThread.current !== snap.threadId
    ) {
      snapTranscriptToEndAfterFrame();
    }
    void Promise.all([
      rpc.routines.list({ botId: id }).catch(() => null),
      rpc.skills.list({ botId: id }).catch(() => null),
      refreshComputerScreen(id).catch(() => null),
    ]).then(([routines, skills]) => {
      if (
        activeBotId.current !== id ||
        epoch !== historyEpoch.current ||
        request !== threadRefreshEpoch.current
      ) {
        return;
      }
      if (routines) {
        setRoutines(routines);
        setRoutinesBotId(id);
      }
      if (skills) {
        setTaughtSkills(skills);
        setTaughtSkillsBotId(id);
      }
    });
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
    cacheComputerFor(id, { screenUrl: screen.url });
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
      updateSnapshot((prev) => prependThreadMessagePage(prev, page));
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
    const appliedAtStart = botsRefreshApplied.current;
    void takeInitialBootstrap(botId)
      .then((bootstrap) => {
        if (cancelled) return;
        const groupList = bootstrap.groups;
        setBootstrapMe(bootstrap.me);
        // Skip list/route writes only if a later refreshBots() successfully
        // committed (failed refreshes bump epoch but not botsRefreshApplied).
        const applyBotLists = appliedAtStart === botsRefreshApplied.current;
        if (applyBotLists) {
          setBots(bootstrap.bots);
          setBotSections(bootstrap.botSections);
          setArchivedBots(bootstrap.archivedBots);
          setArchivedGroups(bootstrap.archivedGroups);
          setGroups(groupList);
          setSpaces(bootstrap.spaces);
          setInitialBotsLoaded(true);
        }
        if (!groupId && bootstrap.thread) {
          bootstrappedThread.current = bootstrap.thread;
          commitSnapshot(bootstrap.thread);
          commitComputer(bootstrap.thread.computer ?? null);
          setRoutines(bootstrap.routines);
          setRoutinesBotId(bootstrap.thread.botId ?? null);
          markOnce("rk:renderer:bots-response");
          markOnce("rk:renderer:thread-response");
        }
        if (!applyBotLists) return;
        if (
          bootstrap.bots.length === 0 &&
          bootstrap.archivedBots.length === 0 &&
          groupList.length === 0 &&
          bootstrap.archivedGroups.length === 0
        ) {
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
    // Poll skips while a refresh is in flight; focus/visibility and event-driven
    // callers still bump botsRefreshEpoch so only the latest response applies.
    const poll = window.setInterval(() => {
      if (botsRefreshInFlight.current > 0) return;
      refreshVisibleBots();
    }, 3_000);
    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimer);
      window.clearInterval(poll);
      window.removeEventListener("focus", refreshVisibleBots);
      document.removeEventListener("visibilitychange", refreshVisibleBots);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void rpc.agentSkills
      .list()
      .then((skills) => {
        if (!cancelled) setAgentSkills(skills);
      })
      .catch(() => {
        if (!cancelled) setAgentSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAgentSkills = useCallback(() => {
    void rpc.agentSkills
      .list()
      .then(setAgentSkills)
      .catch(() => undefined);
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
    const pendingJump = searchParamsRef.current.get("m");
    if (!pendingJump) {
      pinnedAroundRef.current = null;
    }
    screenRequest.current += 1;
    const cached = computerCacheRef.current.get(active.id);
    if (cached) {
      // Paint the last-known computer instantly; refreshThread/refreshComputerScreen
      // below still run and reconcile with fresh data in the background.
      setScreenUrl(cached.screenUrl);
      commitComputer(cached.computer);
    } else {
      setScreenUrl(null);
    }
    expandedHistoryThread.current = null;
    historyEpoch.current += 1;
    const abort = new AbortController();
    void (async () => {
      const primed = bootstrappedThread.current;
      bootstrappedThread.current = null;
      // Pending search jumps load the around-page separately; avoid replacing it with latest.
      const snap =
        primed?.botId === active.id
          ? primed
          : pendingJump
            ? await rpc.threads
                .get({ botId: active.id }, { signal: threadSnapshotSignal(abort.signal) })
                .catch(() => null)
            : await refreshThread(active.id, threadSnapshotSignal(abort.signal)).catch(() => null);
      if (abort.signal.aborted) return;
      let subscribedThreadId = snap?.threadId;
      let initialCursor = snap?.cursor ?? -1;
      let headRetryMs = 250;
      while (!subscribedThreadId && !abort.signal.aborted) {
        const head = await rpc.threads
          .head({ botId: active.id }, { signal: threadSnapshotSignal(abort.signal) })
          .catch(() => null);
        if (head) {
          subscribedThreadId = head.threadId;
          initialCursor = head.cursor;
          break;
        }
        try {
          await abortableDelay(headRetryMs, abort.signal);
        } catch {
          return;
        }
        headRetryMs = Math.min(headRetryMs * 2, 5_000);
      }
      if (!subscribedThreadId || abort.signal.aborted) return;
      let cursor = initialCursor;
      let snapshotReady = snapshotRef.current?.threadId === subscribedThreadId;
      const pendingSnapshotEvents: ProductEvent[] = [];
      if (!snapshotReady) {
        void (async () => {
          let snapshotRetryMs = 250;
          while (!snapshotReady && !abort.signal.aborted) {
            try {
              await abortableDelay(snapshotRetryMs, abort.signal);
            } catch {
              return;
            }
            await refreshThread(active.id, threadSnapshotSignal(abort.signal)).catch(() => null);
            if (abort.signal.aborted) return;
            const committed = snapshotRef.current;
            if (committed?.threadId === subscribedThreadId) {
              snapshotReady = true;
              const pending = pendingSnapshotEvents.splice(0);
              for (const event of pending) {
                if (event.seq > committed.cursor) {
                  applyThreadEvent(event, commitSnapshot, commitComputer, snapshotRef, computerRef);
                }
              }
              return;
            }
            snapshotRetryMs = Math.min(snapshotRetryMs * 2, 5_000);
          }
        })();
      }
      const streamReady = true;
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
            if (snapshotReady && snapshotRef.current?.threadId === event.threadId) {
              applyThreadEvent(event, commitSnapshot, commitComputer, snapshotRef, computerRef);
            } else {
              pendingSnapshotEvents.push(event);
            }
            const currentBot = botsRef.current.find((bot) => bot.id === active.id);
            notifyBrowserForEvent(
              event,
              subscribedThreadId,
              initialCursor,
              streamReady,
              currentBot?.name ?? active.name,
              currentBot?.notifyOnFinish ?? false,
              false,
            );
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
              event.type === "run.started" ||
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
            if (
              isRunTerminalEvent(event) ||
              event.type === "run.waiting_input" ||
              event.type === "skill.teaching.stopped"
            ) {
              // waiting_input: reconcile ask cards if a stale post-send refresh raced SSE.
              void refreshThread(active.id).catch(() => undefined);
            } else if (isComputerStatusEvent(event)) {
              void refreshComputerScreen(active.id).catch(() => undefined);
            }
          }
        } catch {
          // The durable cursor below makes reconnects safe after a transient network failure.
        }
        if (abort.signal.aborted) break;
        await refreshThread(active.id, threadSnapshotSignal(abort.signal)).catch(() => null);
        await abortableDelay(retryMs, abort.signal);
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    })();
    return () => {
      abort.abort();
    };
  }, [active?.id, markBotReadIfVisible, notifyBrowserForEvent]);

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
    const pendingJump = searchParamsRef.current.get("m");
    if (!pendingJump) {
      pinnedAroundRef.current = null;
      expandedHistoryThread.current = null;
    }
    historyEpoch.current += 1;
    const abort = new AbortController();
    void (async () => {
      const snap = pendingJump
        ? await rpc.threads
            .get({ groupId }, { signal: threadSnapshotSignal(abort.signal) })
            .catch(() => null)
        : await refreshGroupThread(groupId, threadSnapshotSignal(abort.signal)).catch(() => null);
      if (abort.signal.aborted) return;
      let subscribedThreadId = snap?.threadId;
      let initialCursor = snap?.cursor ?? -1;
      let headRetryMs = 250;
      while (!subscribedThreadId && !abort.signal.aborted) {
        const head = await rpc.threads
          .head({ groupId }, { signal: threadSnapshotSignal(abort.signal) })
          .catch(() => null);
        if (head) {
          subscribedThreadId = head.threadId;
          initialCursor = head.cursor;
          break;
        }
        try {
          await abortableDelay(headRetryMs, abort.signal);
        } catch {
          return;
        }
        headRetryMs = Math.min(headRetryMs * 2, 5_000);
      }
      if (!subscribedThreadId || abort.signal.aborted) return;
      let cursor = initialCursor;
      let snapshotReady = snapshotRef.current?.threadId === subscribedThreadId;
      const pendingSnapshotEvents: ProductEvent[] = [];
      if (!snapshotReady) {
        void (async () => {
          let snapshotRetryMs = 250;
          while (!snapshotReady && !abort.signal.aborted) {
            try {
              await abortableDelay(snapshotRetryMs, abort.signal);
            } catch {
              return;
            }
            await refreshGroupThread(groupId, threadSnapshotSignal(abort.signal)).catch(() => null);
            if (abort.signal.aborted) return;
            const committed = snapshotRef.current;
            if (committed?.threadId === subscribedThreadId) {
              snapshotReady = true;
              const pending = pendingSnapshotEvents.splice(0);
              for (const event of pending) {
                if (event.seq > committed.cursor) {
                  applyThreadEvent(event, commitSnapshot, commitComputer, snapshotRef, computerRef);
                }
              }
              return;
            }
            snapshotRetryMs = Math.min(snapshotRetryMs * 2, 5_000);
          }
        })();
      }
      const streamReady = true;
      let retryMs = 250;
      while (!abort.signal.aborted) {
        try {
          const events = await rpc.threads.subscribe({ groupId, cursor }, { signal: abort.signal });
          for await (const event of events) {
            if (abort.signal.aborted) break;
            cursor = Math.max(cursor, event.seq);
            retryMs = 250;
            if (snapshotReady && snapshotRef.current?.threadId === event.threadId) {
              applyThreadEvent(event, commitSnapshot, commitComputer, snapshotRef, computerRef);
            } else {
              pendingSnapshotEvents.push(event);
            }
            const eventBot = botsRef.current.find((bot) => bot.id === event.botId);
            notifyBrowserForEvent(
              event,
              subscribedThreadId,
              initialCursor,
              streamReady,
              eventBot?.name ?? activeGroup.name,
              true,
              true,
            );
            if (event.type === "thread.message.created" && event.payload.role === "bot") {
              readVisibleGroups.current.delete(groupId);
              markVisibleGroupRead();
            }
            if (event.type === "run.started" || isRunTerminalEvent(event)) {
              void refreshBots().catch(() => undefined);
            }
            if (isRunTerminalEvent(event) || event.type === "run.waiting_input") {
              // waiting_input: reconcile ask cards if a stale post-send refresh raced SSE.
              void refreshGroupThread(groupId).catch(() => undefined);
            }
          }
        } catch {
          // reconnect safely
        }
        if (abort.signal.aborted) break;
        await refreshGroupThread(groupId, threadSnapshotSignal(abort.signal)).catch(() => null);
        await abortableDelay(retryMs, abort.signal);
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    })();
    return () => {
      window.removeEventListener("focus", markVisibleGroupRead);
      document.removeEventListener("visibilitychange", markVisibleGroupRead);
      abort.abort();
    };
  }, [activeGroup?.id, groupId, notifyBrowserForEvent]);

  const sidebarGroups = useMemo(() => {
    const needle = query.toLowerCase();
    const sidebarSpaces =
      spaces.length > 0
        ? spaces.map((space) =>
            space.id === bootstrapMe?.spaceId ? { ...space, bots, groups, botSections } : space,
          )
        : bootstrapMe
          ? [
              {
                id: bootstrapMe.spaceId,
                name: "Personal",
                isDefault: true,
                bots,
                groups,
                botSections,
              },
            ]
          : [];
    const showSpaceNames = sidebarSpaces.length > 1;
    return sidebarSpaces.flatMap((space) => {
      const visibleBots = space.bots.filter((bot) =>
        `${bot.name} ${bot.title ?? ""} ${bot.preview ?? ""}`.toLowerCase().includes(needle),
      );
      const visibleGroups = space.groups.filter((group) =>
        `${group.name} ${group.preview}`.toLowerCase().includes(needle),
      );
      const sections = groupBotsForSidebar(
        [
          ...visibleBots.map((chat) => ({ kind: "bot" as const, chat })),
          ...visibleGroups.map((chat) => ({ kind: "group" as const, chat })),
        ].map((item) => ({ ...item, pinned: item.chat.pinned, sectionId: item.chat.sectionId })),
        space.botSections,
      ).map((group) => ({
        ...group,
        key: showSpaceNames ? `space:${space.id}:${group.key}` : group.key,
        title: showSpaceNames
          ? group.title
            ? `${space.name} · ${group.title}`
            : space.name
          : group.title,
        showLock: showSpaceNames,
        emptySpaceId: undefined as string | undefined,
      }));
      if (sections.length > 0) return sections;
      // Keep empty spaces selectable; chat clicks are the only switch control.
      if (!showSpaceNames) return [];
      if (needle && (space.bots.length > 0 || space.groups.length > 0)) return [];
      return [
        {
          key: `space:${space.id}:empty`,
          title: space.name,
          bots: [],
          showLock: true,
          emptySpaceId: space.id,
        },
      ];
    });
  }, [bootstrapMe, botSections, bots, groups, spaces, query]);

  const openSpaceChat = useCallback(
    (spaceId: string, path: string) => {
      setMobileSidebarOpen(false);
      const previousSpaceId = selectedSpaceId();
      // Persist the active space (including primary) so voice/RPC headers match the chat.
      const selectionStored = selectSpace(spaceId);
      if (!selectionStored) return;
      const previousEffective = previousSpaceId ?? bootstrapMe?.spaceId;
      const boundaryChanged = previousEffective !== spaceId;
      // Soft-navigate within the same space; reload only when the auth boundary changes
      // so bootstrapped bots/groups match the request header.
      if (boundaryChanged) {
        window.location.assign(path);
        return;
      }
      navigate(path);
    },
    [bootstrapMe?.spaceId, navigate],
  );
  const flushBotOrder = useCallback(async () => {
    if (savingBotOrderRef.current) return;
    savingBotOrderRef.current = true;
    try {
      while (pendingBotOrderRef.current) {
        const botIds = pendingBotOrderRef.current;
        pendingBotOrderRef.current = null;
        try {
          await rpc.bots.reorder({ botIds });
        } catch {
          // Keep a newer order queued during this failed save; only roll back
          // when nothing else is pending.
          if (pendingBotOrderRef.current === null) {
            await refreshBots(false, true).catch(() => undefined);
          }
        }
      }
    } finally {
      savingBotOrderRef.current = false;
      // A reorder may have arrived while saving=true and returned early.
      if (pendingBotOrderRef.current) {
        void flushBotOrder();
      }
    }
  }, [refreshBots]);
  const reorderRosterBot = useCallback(
    (sourceId: string, targetId: string, groupBotIds: string[]) => {
      if (!groupBotIds.includes(sourceId) || !groupBotIds.includes(targetId)) return;
      const current = botsRef.current;
      const reordered = reorderBotTo(current, sourceId, targetId);
      if (reordered === current) return;
      const next = [...reordered];
      botOrderEpochRef.current += 1;
      botsRef.current = next;
      setBots(next);
      pendingBotOrderRef.current = next.map((bot) => bot.id);
      void flushBotOrder();
    },
    [flushBotOrder],
  );
  const toggleSidebarSection = useCallback(
    (key: string) => {
      setCollapsedSidebarSections((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        const storageKey = collapsedSidebarSectionsStorageKey(userId);
        if (storageKey) {
          try {
            window.localStorage.setItem(storageKey, JSON.stringify([...next]));
          } catch {
            // Keep the UI usable when storage is unavailable.
          }
        }
        return next;
      });
    },
    [userId],
  );
  const spaceQuery = query.trim();
  const showSpaceSearch = spaceQuery.length > 0;

  useEffect(() => {
    if (!showSpaceSearch) {
      setSearchHits([]);
      setSearchLoading(false);
      return;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      void rpc.search
        .query({ q: spaceQuery })
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
  }, [showSpaceSearch, spaceQuery]);

  async function jumpToSearchHit(hit: SearchHit) {
    setQuery("");
    setSearchHits([]);
    const params = new URLSearchParams();
    if (hit.messageId) params.set("m", hit.messageId);
    if (hit.routineId) params.set("routine", hit.routineId);
    navigate({
      pathname: hit.groupId ? `/app/g/${hit.groupId}` : `/app/${hit.botId}`,
      search: params.toString() ? `?${params.toString()}` : undefined,
    });
  }

  async function jumpToMessage(target: { botId?: string; groupId?: string; messageId: string }) {
    const threadTarget = searchHitThreadTarget(target);
    const epoch = historyEpoch.current;
    jumpGeneration.current += 1;
    const jumpId = jumpGeneration.current;
    const [snap, page] = await Promise.all([
      rpc.threads.get(threadTarget),
      rpc.threads.messages({ ...threadTarget, around: { messageId: target.messageId } }),
    ]);
    // The epoch check drops a jump that raced a conversation clear (or a bot switch): applying
    // the fetched page would pin deleted messages that every later refresh keeps restoring.
    // jumpId drops an older jump that finished after a newer click.
    if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
    if (target.groupId && activeGroupId.current !== target.groupId) return;
    if (target.botId && activeBotId.current !== target.botId) return;
    const targetInPage = userVisibleMessages(page.messages, { includePeerReceipts: true }).some(
      (message) => message.id === target.messageId,
    );
    expandedHistoryThread.current = targetInPage ? page.threadId : null;
    pinnedAroundRef.current = targetInPage
      ? {
          ...threadTarget,
          messageId: target.messageId,
          threadId: page.threadId,
          messages: page.messages,
          olderCursor: page.olderCursor,
        }
      : null;
    if (targetInPage) initiallyScrolledThread.current = page.threadId;
    commitSnapshot({
      ...snap,
      messages: targetInPage ? page.messages : snap.messages,
      olderCursor: targetInPage ? page.olderCursor : snap.olderCursor,
    });
    if (threadTarget.botId) {
      commitComputer(snap.computer ?? null);
      // Don't block parent-scroll on routines metadata; a list failure must not abort the jump.
      void rpc.routines
        .list({ botId: threadTarget.botId })
        .then((routines) => {
          if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
          if (activeBotId.current !== threadTarget.botId) return;
          setRoutines(routines);
          setRoutinesBotId(threadTarget.botId);
        })
        .catch(() => undefined);
    } else {
      commitComputer(null);
      setRoutines([]);
      setRoutinesBotId(null);
    }
    window.requestAnimationFrame(() => {
      if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
      if (!targetInPage) {
        const element = messageScroll.current;
        if (element) {
          element.scrollTop = element.scrollHeight;
          initiallyScrolledThread.current = page.threadId;
        }
        return;
      }
      document
        .querySelector(`[data-message-id="${target.messageId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  useEffect(() => {
    const messageId = searchParams.get("m");
    const routineId = searchParams.get("routine");
    if (inGroup && groupId && messageId) {
      void jumpToMessage({ groupId, messageId }).finally(() => {
        // Keep expandedHistoryThread; only strip the jump URL so refresh does not remount.
        const next = new URLSearchParams(searchParams);
        next.delete("m");
        setSearchParams(next, { replace: true });
      });
      return;
    }
    if (!active) return;
    if (routineId && routinesBotId === active.id) {
      const routine = routines.find((item) => item.id === routineId);
      if (routine) {
        setRoutineDraft(draftFromRoutine(routine));
        setRoutineWebhookSecret(null);
        setEditingRoutine(routine);
        setPanel("routine");
      } else {
        setPanel("computer");
      }
      const next = new URLSearchParams(searchParams);
      next.delete("routine");
      setSearchParams(next, { replace: true });
    }
    if (messageId) {
      void jumpToMessage({ botId: active.id, messageId }).finally(() => {
        const next = new URLSearchParams(searchParams);
        next.delete("m");
        setSearchParams(next, { replace: true });
      });
    }
  }, [active?.id, groupId, inGroup, routines, routinesBotId, searchParams, setSearchParams]);
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
  const workingRuns = currentRuns.filter((run) =>
    ["running", "queued", "leased"].includes(run.status),
  );
  const transcriptRunning = workingRuns.length > 0;
  const composerRunning = currentRuns.some((run) => isActive(run.status));
  const runError = threadRunError(activeSnapshot, dismissedRunErrorIds);
  const displayedRunError = !sendError && !dictationError ? runError : null;
  const displayedRunErrorId = displayedRunError ? (activeSnapshot?.run?.id ?? null) : null;
  const handleRunErrorPresented = useCallback((runId: string) => {
    rememberSeenRunErrorId(runId);
  }, []);
  const transcriptMessages = useMemo(
    () => userVisibleMessages(activeSnapshot?.messages ?? [], { includePeerReceipts: true }),
    [activeSnapshot?.messages],
  );
  const transcriptArtifactTarget = useMemo<ArtifactTarget>(
    () => (inGroup ? { groupId: groupId ?? "" } : { botId: active?.id ?? "" }),
    [active?.id, groupId, inGroup],
  );
  const transcriptMembers = activeSnapshot?.members ?? activeGroup?.members;
  const resolveTranscriptBot = useCallback(
    (botId: string) => {
      const bot = bots.find((candidate) => candidate.id === botId);
      if (bot) return bot;
      return transcriptMembers?.find((member) => member.botId === botId);
    },
    [bots, transcriptMembers],
  );
  const workingBots: GroupAvatarMember[] = workingRuns.map((run) => {
    const bot = resolveTranscriptBot(run.botId);
    return {
      botId: run.botId,
      color: bot?.color ?? "#85858A",
      name: bot?.name,
      status: run.status,
    };
  });
  const resolveTranscriptMemberName = useCallback(
    (botId: string | undefined) => memberName(transcriptMembers, botId),
    [transcriptMembers],
  );
  const replyTargetName = activeReplyTarget
    ? activeReplyTarget.role === "user"
      ? t`You`
      : (resolveTranscriptMemberName(activeReplyTarget.botId) ?? active?.name ?? t`Bot`)
    : undefined;
  const composerMentionTargets = useMemo(
    () =>
      buildComposerMentionOptions({
        query: "",
        includeEveryone: inGroup,
        currentGroupId: groupId,
        bots: bots.map((bot) => ({ id: bot.id, name: bot.name, color: bot.color })),
        groups: groups.map((group) => ({ id: group.id, name: group.name })),
        routines: mentionRoutines.map((routine) => ({
          id: routine.id,
          name: routine.name,
          crons: routine.crons,
          botId: routine.botId,
          botName: routine.botName,
        })),
        connectors: mentionConnectors,
      }),
    [bots, groupId, groups, inGroup, mentionConnectors, mentionRoutines],
  );
  const shellReady =
    initialBotsLoaded &&
    (inGroup
      ? Boolean(activeGroup && activeSnapshot)
      : bots.length === 0 || Boolean(active && activeSnapshot));
  const refreshThreadRef = useRef(refreshThread);
  refreshThreadRef.current = refreshThread;
  const refreshGroupThreadRef = useRef(refreshGroupThread);
  refreshGroupThreadRef.current = refreshGroupThread;
  const loadOlderMessagesRef = useRef(loadOlderMessages);
  loadOlderMessagesRef.current = loadOlderMessages;
  const jumpToMessageRef = useRef(jumpToMessage);
  jumpToMessageRef.current = jumpToMessage;

  const mentionBotsKey = useMemo(
    () => bots.map((bot) => `${bot.id}:${bot.name}`).join(","),
    [bots],
  );
  const botsForMentionsRef = useRef(bots);
  botsForMentionsRef.current = bots;

  useEffect(() => {
    const bots = botsForMentionsRef.current;
    if (!initialBotsLoaded || bots.length === 0) {
      setMentionRoutines([]);
      setMentionConnectors([]);
      return;
    }
    let cancelled = false;
    const botNameById = new Map(bots.map((bot) => [bot.id, bot.name]));
    void Promise.all(
      bots.map((bot) =>
        rpc.routines
          .list({ botId: bot.id })
          .then((rows) =>
            rows.map((routine) => ({
              ...routine,
              botName: botNameById.get(bot.id) ?? bot.name,
            })),
          )
          .catch(() => [] as Array<Routine & { botName?: string }>),
      ),
    ).then((lists) => {
      if (!cancelled) setMentionRoutines(lists.flat());
    });
    void Promise.all([
      rpc.connections.list().catch(() => [] as Connection[]),
      rpc.connections.catalog({}).catch(() => [] as ConnectionCatalogItem[]),
    ]).then(([connections, catalog]) => {
      if (cancelled) return;
      const connected = connections.filter((row) => row.status === "connected");
      const options: Array<{
        id: string;
        name: string;
        authStatus: "connected" | "needs_auth";
        connectionId?: string;
      }> = connected.map((row) => ({
        id: row.id,
        name: row.displayName,
        authStatus: "connected" as const,
        connectionId: row.id,
      }));
      for (const item of catalog) {
        if (item.connected || item.noAuth) continue;
        if (
          connected.some(
            (row) =>
              row.provider.toLowerCase() === item.slug.toLowerCase() ||
              row.displayName.toLowerCase() === item.name.toLowerCase(),
          )
        ) {
          continue;
        }
        options.push({
          id: `catalog:${item.connectorId}:${item.slug}`,
          name: item.name,
          authStatus: "needs_auth",
        });
      }
      setMentionConnectors(options);
    });
    return () => {
      cancelled = true;
    };
  }, [initialBotsLoaded, mentionBotsKey]);

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
    const pin = pinnedAroundRef.current;
    if (inGroup) {
      if (!groupId || !snapshot || snapshot.groupId !== groupId) return;
      if (initiallyScrolledThread.current === snapshot.threadId) return;
      if (expandedHistoryThread.current === snapshot.threadId) return;
      if (pin?.groupId === groupId) return;
    } else {
      if (!active || !snapshot || snapshot.botId !== active.id) return;
      if (initiallyScrolledThread.current === snapshot.threadId) return;
      if (expandedHistoryThread.current === snapshot.threadId) return;
      if (pin?.botId === active.id) return;
    }
    const element = messageScroll.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    initiallyScrolledThread.current = snapshot.threadId;
  }, [active, groupId, inGroup, snapshot?.botId, snapshot?.groupId, snapshot?.threadId]);

  const openBot = useCallback((id: string) => navigate(`/app/${id}`), [navigate]);
  const loadOlder = useCallback(() => loadOlderMessagesRef.current(), []);
  const jumpToReplyMessage = useCallback((messageId: string) => {
    const existing = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (existing) {
      // Cancel any in-flight around-fetch so it cannot overwrite this scroll.
      jumpGeneration.current += 1;
      existing.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const groupId = activeGroupId.current;
    if (groupId) {
      void jumpToMessageRef.current({ groupId, messageId });
      return;
    }
    const botId = activeBotId.current;
    if (botId) void jumpToMessageRef.current({ botId, messageId });
  }, []);
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
  const reactToMessage = useCallback(
    async (message: ThreadMessage) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      try {
        await rpc.threads.react({
          ...(groupId ? { groupId } : { botId: botId! }),
          messageId: message.id,
          thumbsUp: !message.thumbsUp,
        });
      } catch (error) {
        const stillHere = groupId
          ? activeGroupId.current === groupId
          : activeBotId.current === botId;
        if (!stillHere) return;
        setSendError(error instanceof Error ? error.message : t`Could not update reaction`);
      }
    },
    [t],
  );
  const onAttachmentPick = useCallback(
    async (files: FileList | null) => {
      const threadKey = activeGroupId.current ?? activeBotId.current;
      if (!threadKey || !files?.length) return;
      const existing = attachmentsForThread(pendingAttachments, threadKey);
      const next: PendingAttachment[] = [];
      const skipped: string[] = [];
      for (const file of Array.from(files)) {
        if (existing.length + next.length >= ATTACHMENT_MAX_COUNT) {
          skipped.push(t`${file.name} (max ${ATTACHMENT_MAX_COUNT} attachments)`);
          continue;
        }
        if (file.size > ATTACHMENT_MAX_BYTES) {
          skipped.push(t`${file.name} (over 10 MiB)`);
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
      setAttachmentNotice(skipped.length ? t`Skipped ${skipped.join(", ")}` : null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [pendingAttachments, t],
  );
  const removeAttachment = useCallback((attachment: PendingAttachment) => {
    revokePendingAttachmentPreviews([attachment]);
    setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id));
  }, []);
  const sendMessage = useCallback(
    async (text: string, mentions: ComposerMention[] = []) => {
      const initialBotTarget = activeBotId.current;
      const initialGroupTarget = activeGroupId.current;
      if ((!initialBotTarget && !initialGroupTarget) || sending) return;
      const originThreadKey = initialGroupTarget ?? initialBotTarget;
      const attachments = attachmentsForThread(pendingAttachments, originThreadKey);
      const plan = resolveComposerSendPlan({
        text,
        mentions,
        hasAttachments: attachments.length > 0,
      });
      if (plan.isNoOp) return;
      const reroutedToGroup = Boolean(
        plan.rerouteGroupId && plan.rerouteGroupId !== initialGroupTarget,
      );
      const groupTarget = plan.rerouteGroupId ?? initialGroupTarget;
      const botTarget = reroutedToGroup ? undefined : initialBotTarget;
      if (
        plan.shouldSend &&
        (groupTarget || botsRef.current.find((bot) => bot.id === botTarget)?.notifyOnFinish)
      ) {
        const permissionRequest = requestBrowserNotificationPermission();
        if (permissionRequest) void permissionRequest.then(flushPendingBrowserNotifications);
      }
      const trimmed = plan.trimmed;
      setSending(true);
      setSendError(null);
      try {
        if (plan.shouldRunRoutines) {
          const sendNonce = newClientNonce();
          await Promise.all(
            plan.routineIds.map((routineId) =>
              rpc.routines.testRun({
                routineId,
                clientNonce: `routine-mention:${sendNonce}:${routineId}`,
              }),
            ),
          );
        }
        if (!plan.shouldSend) {
          setReplyTarget(null);
          revokePendingAttachmentPreviews(attachments);
          setPendingAttachments((current) =>
            current.filter((attachment) => attachment.threadKey !== originThreadKey),
          );
          setAttachmentNotice(null);
          if (reroutedToGroup && groupTarget) {
            navigate(`/app/g/${groupTarget}`);
            return;
          }
          if (groupTarget && activeGroupId.current === groupTarget) {
            await refreshGroupThreadRef.current(groupTarget);
          } else if (botTarget && activeBotId.current === botTarget) {
            await refreshThreadRef.current(botTarget);
          }
          return;
        }
        const artifactIds: string[] = [];
        for (const pending of attachments) {
          const mimeType = inferAttachmentMimeType(pending.file.name, pending.file.type);
          if (!mimeType) {
            throw new Error(t`Unsupported file type: ${pending.file.name}`);
          }
          const contentBase64 = await readFileAsBase64(pending.file);
          const artifact = await rpc.artifacts.create(
            groupTarget
              ? { groupId: groupTarget, name: pending.file.name, mimeType, contentBase64 }
              : { botId: botTarget!, name: pending.file.name, mimeType, contentBase64 },
          );
          artifactIds.push(artifact.id);
        }
        const clientNonce = newClientNonce();
        if (groupTarget) {
          await rpc.threads.send({
            groupId: groupTarget,
            clientNonce,
            text: trimmed || undefined,
            mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
            artifactIds: artifactIds.length ? artifactIds : undefined,
            replyToMessageId: reroutedToGroup ? undefined : activeReplyTarget?.id,
          });
        } else if (botTarget) {
          await rpc.threads.send({
            botId: botTarget,
            clientNonce,
            text: trimmed || undefined,
            mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
            artifactIds: artifactIds.length ? artifactIds : undefined,
            replyToMessageId: activeReplyTarget?.id,
          });
        }
        setReplyTarget(null);
        revokePendingAttachmentPreviews(attachments);
        setPendingAttachments((current) =>
          current.filter((attachment) => attachment.threadKey !== originThreadKey),
        );
        // Refresh sidebar status even when a bot→group reroute navigates away below.
        void refreshBots().catch(() => undefined);
        if (reroutedToGroup && groupTarget) {
          navigate(`/app/g/${groupTarget}`);
          return;
        }
        if (groupTarget && activeGroupId.current === groupTarget) setAttachmentNotice(null);
        if (botTarget && activeBotId.current === botTarget) setAttachmentNotice(null);
        if (groupTarget) await refreshGroupThreadRef.current(groupTarget);
        else if (botTarget) await refreshThreadRef.current(botTarget);
      } catch (error) {
        if (reroutedToGroup && groupTarget) {
          setSendError(error instanceof Error ? error.message : t`Failed to send message`);
        } else if (groupTarget && activeGroupId.current === groupTarget) {
          setSendError(error instanceof Error ? error.message : t`Failed to send message`);
        } else if (botTarget && activeBotId.current === botTarget) {
          setSendError(error instanceof Error ? error.message : t`Failed to send message`);
        }
      } finally {
        setSending(false);
      }
    },
    [
      activeReplyTarget?.id,
      flushPendingBrowserNotifications,
      navigate,
      pendingAttachments,
      sending,
      t,
    ],
  );
  const followUpMessage = useCallback(async (text: string) => {
    const id = activeBotId.current;
    if (!id) return;
    await rpc.threads.followUp({ botId: id, text });
    await refreshThreadRef.current(id);
  }, []);
  const stopRun = useCallback(async () => {
    if (sending) return;
    setSending(true);
    try {
      const botTarget = activeBotId.current;
      const groupTarget = activeGroupId.current;
      if (groupTarget) {
        setSendError(null);
        try {
          await rpc.threads.stop({ groupId: groupTarget });
        } catch (error) {
          if (activeGroupId.current === groupTarget) {
            setSendError(error instanceof Error ? error.message : t`Failed to stop`);
          }
          return;
        }
        // Stop has no terminal event; clear run UI before refresh races with in-flight gets.
        if (activeGroupId.current === groupTarget) {
          updateSnapshot((prev) =>
            prev && prev.groupId === groupTarget ? clearActiveThreadRuns(prev) : prev,
          );
        }
        await refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
        return;
      }
      if (!botTarget) return;
      setSendError(null);
      try {
        await rpc.threads.stop({ botId: botTarget });
      } catch (error) {
        if (activeBotId.current === botTarget) {
          setSendError(error instanceof Error ? error.message : t`Failed to stop`);
        }
        return;
      }
      // Stop does not emit a terminal thread event. Clear local run/busy immediately so a
      // superseded in-flight refresh (older cursor) cannot leave Stop enabled / Take control
      // blocked while the API is already idle.
      if (activeBotId.current === botTarget) {
        updateSnapshot((prev) =>
          !prev || (prev.botId !== botTarget && prev.botId) ? prev : clearActiveThreadRuns(prev),
        );
        const currentComputer = computerRef.current;
        if (currentComputer?.busyBotName) {
          commitComputer({ ...currentComputer, busyBotName: null });
        }
      }
      await refreshThreadRef.current(botTarget).catch(() => undefined);
    } finally {
      setSending(false);
    }
  }, [sending, t]);
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
    setRoutineDraft({ ...emptyRoutineDraft(), name, prompt });
    setRoutineWebhookSecret(null);
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
    setGroups((current) =>
      current.some((item) => item.id === group.id) ? current : [group, ...current],
    );
    navigate(`/app/g/${group.id}`);
    setPanel(null);
    await refreshBots().catch(() => undefined);
  }

  async function createBot(input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
  }) {
    const bot = await rpc.bots.create({
      ...normalizeCreateBotProfile(input),
      notifyOnFinish: true,
      computerMode: input.computerMode,
    });
    setBots((current) =>
      current.some((item) => item.id === bot.id) ? current : [bot, ...current],
    );
    navigate(`/app/${bot.id}`);
    setPanel(null);
    await refreshBots().catch(() => undefined);
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
      setComputerError(null);
    } catch (error) {
      setComputerError(error instanceof Error ? error.message : t`Could not take control`);
      throw error;
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
      if (!computerPanelAutoUsesBoot(action)) return;
      await bootComputer({
        takeControl: false,
        overlay: action === "boot",
        force: true,
      }).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [panel, active?.id]);

  useEffect(() => {
    setComputerOpen(false);
    setComputerError(null);
  }, [active?.id]);

  useEffect(() => {
    if (!computer?.busyBotName) setComputerError(null);
  }, [computer?.busyBotName]);

  useEffect(() => {
    if (panel !== "routine") {
      routineSaveRequest.current += 1;
      setRoutineError(null);
    }
  }, [panel]);

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
    const blocked = computerTakeoverBlocked(computer, snapshot?.run?.status);
    try {
      await bootComputer({
        takeControl: needsTakeover && !blocked,
        overlay: (needsTakeover && !blocked) || computer?.state !== "running",
        force: computer?.state !== "running",
      });
      setComputerOpen(true);
    } catch {
      // computerError already set in bootComputer
    }
  }

  async function releaseComputer(reason?: ComputerReleaseReason) {
    if (!active) return;
    setComputerOpen(false);
    await rpc.computer.release({ botId: active.id, reason }).catch(() => undefined);
    await refreshThread(active.id);
  }

  function dismissComposerError() {
    // The strip shows one message at a time, so only dismiss the run failure when it is the
    // one on screen; otherwise a live run would be silenced before it has even failed.
    const failedRunId = displayedRunErrorId;
    setSendError(null);
    setDictationError(null);
    if (failedRunId) {
      rememberSeenRunErrorId(failedRunId);
      setDismissedRunErrorIds((current) => new Set(current).add(failedRunId));
    }
  }

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl);
  const hasControl = userHoldsComputerControl(computer, active?.id);
  const takeoverBlocked = computerTakeoverBlocked(computer, snapshot?.run?.status);

  const userName = session.data?.user.name ?? t`You`;
  const initials = userName
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const shell = (
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
          aria-label={t`Close navigation`}
          onClick={() => setMobileSidebarOpen(false)}
          className="absolute inset-y-0 end-0 start-[min(calc(100%-48px),316px)] z-30 bg-black/60 md:hidden"
        />
      ) : null}
      <aside
        className={`absolute inset-y-0 start-0 z-40 flex w-[calc(100%-48px)] max-w-[316px] shrink-0 flex-col border-e border-[#171719] bg-[#0B0B0C] transition-transform md:static md:z-auto md:w-[316px] md:translate-x-0 ${
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full"
        }`}
      >
        <div className="app-drag flex items-center justify-between px-[18px] pb-3 pt-4">
          <WindowChrome />
          <div className="relative flex items-center gap-2.5">
            <button
              type="button"
              aria-label={t`Activity`}
              aria-pressed={activityMode}
              title={t`Activity`}
              data-activity-mode={activityMode ? "on" : "off"}
              onClick={toggleActivityMode}
              className={`app-no-drag flex h-7 w-7 items-center justify-center rounded-full ${
                activityMode ? "bg-[#4C8DFF] text-white" : "text-[#7A7A80] hover:text-[#C9C9CE]"
              }`}
            >
              <Bell
                size={15}
                strokeWidth={1.8}
                fill={activityMode ? "currentColor" : "none"}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              onClick={() => setCreateMenuOpen((open) => !open)}
              className="app-no-drag text-[21px] text-[#7A7A80] hover:text-[#C9C9CE]"
              title={t`Create`}
            >
              +
            </button>
            {createMenuOpen ? (
              <div className="app-no-drag absolute end-0 top-full z-20 mt-2 min-w-[160px] rounded-xl border border-[#26262A] bg-[#141416] py-1 shadow-lg">
                <button
                  type="button"
                  className="block w-full px-3.5 py-2 text-start text-[14px] text-[#ECECEE] hover:bg-[#1A1A1D]"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    setPanel("create");
                  }}
                >
                  <Trans>New bot</Trans>
                </button>
                <button
                  type="button"
                  className="block w-full px-3.5 py-2 text-start text-[14px] text-[#ECECEE] hover:bg-[#1A1A1D]"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    setPanel("create-group");
                  }}
                >
                  <Trans>New group</Trans>
                </button>
                <div className="my-1 border-t border-[#26262A]" />
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3.5 py-2 text-start text-[14px] text-[#ECECEE] hover:bg-[#1A1A1D]"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    setNewSpaceOpen(true);
                  }}
                >
                  <Lock size={14} strokeWidth={1.8} aria-hidden="true" />
                  <Trans>New space</Trans>
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
            placeholder={t`Search`}
            className="w-full bg-transparent outline-none"
          />
        </div>
        <div className="rk-scroll flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2.5">
          {showSpaceSearch ? (
            <SpaceSearchResults
              hits={searchHits}
              loading={searchLoading}
              onSelect={(hit) => void jumpToSearchHit(hit)}
            />
          ) : (
            <>
              {activityMode ? (
                <ActivityList
                  onOpenRun={(run) => {
                    setMobileSidebarOpen(false);
                    if (run.groupId) navigate(`/app/g/${run.groupId}`);
                    else navigate(`/app/${run.botId}`);
                  }}
                />
              ) : null}
              {sidebarGroups.map((group) => {
                const collapsed = Boolean(group.title) && collapsedSidebarSections.has(group.key);
                const groupBotIds = group.bots.flatMap((item) =>
                  item.kind === "bot" ? [item.chat.id] : [],
                );
                return (
                  <div key={group.key} data-sidebar-group={group.key}>
                    {group.title ? (
                      <div className="pt-2">
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-[#6C6C70] hover:bg-[#1A1A1D] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#8B5CF6]"
                          onClick={() => {
                            if (group.emptySpaceId) {
                              openSpaceChat(group.emptySpaceId, "/onboarding");
                              return;
                            }
                            toggleSidebarSection(group.key);
                          }}
                          aria-expanded={group.emptySpaceId ? undefined : !collapsed}
                          aria-label={
                            group.emptySpaceId
                              ? t`Open ${group.title}`
                              : collapsed
                                ? t`Expand ${group.title}`
                                : t`Collapse ${group.title}`
                          }
                        >
                          <span className="flex min-w-0 items-center gap-1.5 truncate">
                            {group.showLock ? (
                              <Lock size={11} strokeWidth={2} aria-hidden="true" />
                            ) : null}
                            <span className="truncate">{group.title}</span>
                          </span>
                          {group.emptySpaceId ? null : (
                            <ChevronDown
                              size={14}
                              strokeWidth={1.8}
                              className={
                                collapsed
                                  ? "-rotate-90 transition-transform"
                                  : "transition-transform"
                              }
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      </div>
                    ) : null}
                    {!collapsed &&
                      group.bots.map((item) => (
                        <button
                          key={`${item.kind}:${item.chat.id}`}
                          type="button"
                          draggable={item.kind === "bot"}
                          data-roster-bot-id={item.kind === "bot" ? item.chat.id : undefined}
                          aria-keyshortcuts={
                            item.kind === "bot" ? "Alt+ArrowUp Alt+ArrowDown" : undefined
                          }
                          onDragStart={(event) => {
                            if (item.kind !== "bot") return;
                            setDraggedBotId(item.chat.id);
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", item.chat.id);
                          }}
                          onDragOver={(event) => {
                            if (
                              item.kind === "bot" &&
                              draggedBotId &&
                              groupBotIds.includes(draggedBotId)
                            ) {
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                            }
                          }}
                          onDrop={(event) => {
                            if (item.kind !== "bot" || !draggedBotId) return;
                            event.preventDefault();
                            reorderRosterBot(draggedBotId, item.chat.id, groupBotIds);
                            setDraggedBotId(null);
                          }}
                          onDragEnd={() => setDraggedBotId(null)}
                          onKeyDown={(event) => {
                            if (
                              item.kind !== "bot" ||
                              !event.altKey ||
                              (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                            )
                              return;
                            const index = groupBotIds.indexOf(item.chat.id);
                            const target = groupBotIds[index + (event.key === "ArrowUp" ? -1 : 1)];
                            if (!target) return;
                            event.preventDefault();
                            reorderRosterBot(item.chat.id, target, groupBotIds);
                          }}
                          onClick={() => {
                            openSpaceChat(
                              item.chat.spaceId,
                              item.kind === "bot"
                                ? `/app/${item.chat.id}`
                                : `/app/g/${item.chat.id}`,
                            );
                          }}
                          onContextMenu={(event) => {
                            if (item.chat.spaceId !== bootstrapMe?.spaceId) return;
                            event.preventDefault();
                            setBotMenu({
                              kind: item.kind,
                              id: item.chat.id,
                              position: { x: event.clientX, y: event.clientY },
                            });
                          }}
                          className={`flex w-full gap-3 rounded-xl px-2.5 py-[11px] text-start ${
                            item.kind === "bot" ? "cursor-grab active:cursor-grabbing" : ""
                          }`}
                          style={{
                            opacity:
                              item.kind === "bot" && draggedBotId === item.chat.id ? 0.55 : 1,
                            background:
                              (item.kind === "bot" && !inGroup && active?.id === item.chat.id) ||
                              (item.kind === "group" && inGroup && activeGroup?.id === item.chat.id)
                                ? "#161618"
                                : "transparent",
                          }}
                        >
                          {item.kind === "bot" ? (
                            <BotAvatar
                              color={item.chat.color}
                              identity={item.chat.id}
                              size={38}
                              status={item.chat.status}
                            />
                          ) : (
                            <GroupAvatar
                              members={
                                item.chat.id === activeSnapshot?.groupId
                                  ? (activeSnapshot.members ?? item.chat.members)
                                  : item.chat.members
                              }
                              size={38}
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <span
                                dir="auto"
                                data-roster-bot-name={item.kind === "bot" ? "" : undefined}
                                className={`truncate text-[15px] text-[#ECECEE] ${
                                  item.chat.unread ? "font-semibold" : "font-medium"
                                }`}
                              >
                                {item.chat.name}
                                {item.chat.unread ? (
                                  <span className="sr-only">
                                    <Trans> (unread)</Trans>
                                  </span>
                                ) : null}
                              </span>
                              <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-[#6C6C70]">
                                {item.kind === "bot" && item.chat.status !== "idle"
                                  ? item.chat.status
                                  : ""}
                                {item.chat.unread ? (
                                  <span
                                    aria-hidden="true"
                                    className="inline-block h-2 w-2 rounded-full bg-[#8B5CF6]"
                                  />
                                ) : null}
                              </span>
                            </div>
                            {item.kind === "bot" && item.chat.title ? (
                              <>
                                <div
                                  dir="auto"
                                  className={`mt-0.5 truncate text-[13.5px] ${
                                    item.chat.unread
                                      ? "font-medium text-[#C9C9CE]"
                                      : "text-[#85858A]"
                                  }`}
                                >
                                  {item.chat.title}
                                </div>
                                {item.chat.preview ? (
                                  <div dir="auto" className="truncate text-[12.5px] text-[#6C6C70]">
                                    {item.chat.preview}
                                  </div>
                                ) : null}
                              </>
                            ) : (
                              <div
                                dir="auto"
                                className={`mt-0.5 truncate text-[13.5px] ${
                                  item.chat.unread ? "font-medium text-[#C9C9CE]" : "text-[#85858A]"
                                }`}
                              >
                                {item.kind === "bot"
                                  ? item.chat.preview
                                  : item.chat.preview ||
                                    item.chat.members.map((member) => member.name).join(", ")}
                              </div>
                            )}
                          </div>
                        </button>
                      ))}
                  </div>
                );
              })}
            </>
          )}
          {archivedBots.length + archivedGroups.length > 0 && !showSpaceSearch ? (
            <div className="mt-2 border-t border-[#202023] pt-2">
              <button
                type="button"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((open) => !open)}
                className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[13.5px] text-[#85858A] hover:bg-[#131315]"
              >
                <span>
                  <Trans>Archived</Trans>
                </span>
                <span>{archivedBots.length + archivedGroups.length}</span>
              </button>
              {archivedOpen ? (
                <>
                  {archivedBots.map((bot) => (
                    <div key={bot.id} className="flex items-center gap-2 rounded-lg px-2.5 py-2">
                      <BotAvatar
                        color={bot.color}
                        identity={bot.id}
                        size={28}
                        status={bot.status}
                      />
                      <span
                        className="min-w-0 flex-1 truncate text-[14px] text-[#A8A8AD]"
                        dir="auto"
                      >
                        {bot.name}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          void rpc.bots.restore({ botId: bot.id }).then(() => refreshBots(true))
                        }
                        className="text-[12.5px] text-[#C9C9CE] hover:text-white"
                      >
                        <Trans>Restore</Trans>
                      </button>
                      <button
                        type="button"
                        aria-label={t`Delete ${bot.name}`}
                        onClick={() => setDeleteTarget(bot)}
                        className="text-[12.5px] text-[#EF4444]"
                      >
                        <Trans>Delete</Trans>
                      </button>
                    </div>
                  ))}
                  {archivedGroups.map((group) => (
                    <div key={group.id} className="flex items-center gap-2 rounded-lg px-2.5 py-2">
                      <GroupAvatar members={group.members} size={28} />
                      <span
                        className="min-w-0 flex-1 truncate text-[14px] text-[#A8A8AD]"
                        dir="auto"
                      >
                        {group.name}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          void rpc.groups
                            .restore({ groupId: group.id })
                            .then(() => refreshBots(true))
                        }
                        className="text-[12.5px] text-[#C9C9CE] hover:text-white"
                      >
                        <Trans>Restore</Trans>
                      </button>
                      <button
                        type="button"
                        aria-label={t`Delete ${group.name}`}
                        onClick={() => setDeleteGroupTarget(group)}
                        className="text-[12.5px] text-[#EF4444]"
                      >
                        <Trans>Delete</Trans>
                      </button>
                    </div>
                  ))}
                </>
              ) : null}
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
          <span className="text-[14.5px] text-[#C9C9CE]">
            <Trans>Integrations</Trans>
          </span>
        </button>
        <div className="relative">
          {menuOpen ? (
            <div className="absolute bottom-14 inset-x-3 rounded-2xl border border-[#2A2A2F] bg-[#1A1A1D] p-2 shadow-[0_22px_50px_rgba(0,0,0,.55)]">
              <button
                type="button"
                aria-label={t`Settings`}
                onClick={() => {
                  setMenuOpen(false);
                  setAccountSettingsFocusUsage(false);
                  setAccountSettingsOpen(true);
                }}
                className="flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 hover:bg-[#232327]"
              >
                <span className="text-[#9A9AA0]">⚙</span>
                <span className="flex-1 text-start text-[14.5px] text-[#ECECEE]">
                  <Trans>Settings</Trans>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setModelsOpen(true);
                }}
                className="flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 hover:bg-[#232327]"
              >
                <Cpu size={16} strokeWidth={1.7} className="text-[#9A9AA0]" />
                <span className="flex-1 text-start text-[14.5px] text-[#ECECEE]">
                  <Trans>Models</Trans>
                </span>
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
                <span className="flex-1 text-start text-[14.5px] text-[#ECECEE]">
                  <Trans>Memory</Trans>
                </span>
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
                <span className="flex-1 text-start text-[14.5px] text-[#ECECEE]">
                  <Trans>Voice</Trans>
                </span>
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 hover:bg-[#232327]"
                onClick={async () => {
                  setUsage(await rpc.usage.summary());
                }}
              >
                <Gauge size={16} strokeWidth={1.7} className="text-[#9A9AA0]" />
                <span className="flex-1 text-start text-[14.5px] text-[#ECECEE]">
                  <Trans>Usage</Trans>
                </span>
              </button>
              {usage ? (
                <p className="px-3 pb-2 text-[12.5px] text-[#85858A]">
                  <Trans>
                    {usage.runs} runs · {usage.inputTokens + usage.outputTokens} tokens
                  </Trans>
                </p>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  void authClient.signOut().then(() => {
                    clearSpaceSelection();
                    navigate("/");
                  })
                }
                className="flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 hover:bg-[#232327]"
              >
                <LogOut size={16} strokeWidth={1.7} className="text-[#9A9AA0]" />
                <span className="text-[14.5px] text-[#ECECEE]">
                  <Trans>Log out</Trans>
                </span>
              </button>
            </div>
          ) : null}
          <button
            type="button"
            data-testid="user-menu-trigger"
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

      <main
        aria-hidden={mobileSidebarOpen || undefined}
        inert={mobileSidebarOpen}
        className="flex min-w-0 flex-1 flex-col bg-[#0D0D0E]"
      >
        <div className="app-drag flex items-center justify-between border-b border-[#141416] px-3 py-[17px] md:px-[22px]">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              aria-label={t`Open navigation`}
              onClick={() => setMobileSidebarOpen(true)}
              className="app-no-drag grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[#A8A8AD] hover:bg-[#1B1B1E] md:hidden"
            >
              <Menu size={19} strokeWidth={1.7} />
            </button>
            <button
              type="button"
              data-testid="bot-settings-trigger"
              onClick={() => setPanel(inGroup ? "group-settings" : "settings")}
              className="app-no-drag flex min-w-0 items-center gap-3"
            >
              {inGroup ? (
                <GroupAvatar
                  members={activeSnapshot?.members ?? activeGroup?.members ?? []}
                  size={26}
                />
              ) : active ? (
                <BotAvatar
                  color={active.color}
                  identity={active.id}
                  size={26}
                  status={active.status}
                />
              ) : null}
              <span className="min-w-0">
                <span className="block truncate text-[16px] font-medium text-[#ECECEE]" dir="auto">
                  {inGroup
                    ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`)
                    : (active?.name ?? t`Select a bot`)}
                </span>
              </span>
            </button>
          </div>
          <div className="flex items-center gap-1">
            {!inGroup && active ? (
              <button
                type="button"
                title={voiceStatus?.ready ? t`Call` : t`Set up voice to call`}
                aria-label={t`Call`}
                onClick={() => {
                  if (!voiceStatus?.ready) {
                    setVoiceOpen(true);
                    return;
                  }
                  setCallOpen(true);
                }}
                className="app-no-drag grid h-[30px] w-[34px] place-items-center rounded-[9px] hover:bg-[#1B1B1E]"
                style={{ background: callOpen ? "#1B1B1E" : "transparent" }}
              >
                <Phone size={16} strokeWidth={1.6} className="text-[#A8A8AD]" />
              </button>
            ) : null}
            {!inGroup ? (
              <button
                type="button"
                title={t`Agent computer`}
                onClick={() => {
                  const next = panel === "computer" ? null : "computer";
                  setPanel(next);
                  if (next === "computer" && active) {
                    // Refresh run/computer so Take control isn't stuck on a stale busyBotName.
                    void refreshThread(active.id).catch(() => undefined);
                  }
                }}
                className="app-no-drag grid h-[30px] w-[34px] place-items-center rounded-[9px] hover:bg-[#1B1B1E]"
                style={{ background: panel ? "#1B1B1E" : "transparent" }}
              >
                <Monitor size={18} strokeWidth={1.6} className="text-[#A8A8AD]" />
              </button>
            ) : null}
          </div>
        </div>
        <Transcript
          key={activeSnapshot?.threadId}
          scrollRef={messageScroll}
          artifactTarget={transcriptArtifactTarget}
          messages={transcriptMessages}
          olderCursor={activeSnapshot?.olderCursor ?? null}
          loadingOlder={loadingOlder}
          answerableAskMessageId={answerableAskMessageId}
          running={transcriptRunning}
          workingBots={workingBots}
          onLoadOlder={loadOlder}
          onOpenBot={openBot}
          onAnswer={answerMessage}
          onReply={setReplyTarget}
          onReact={reactToMessage}
          onJumpToMessage={jumpToReplyMessage}
          onOpenPeerMessages={(peer) => {
            setPeerConversation(peer);
          }}
          memberName={resolveTranscriptMemberName}
          peerBot={resolveTranscriptBot}
          onRefresh={refreshActiveThread}
          onBotChanged={refreshBots}
          onAddRoutine={addSkillRoutine}
          voiceReady={Boolean(voiceStatus?.ready)}
          speakingMessageId={speakingMessageId}
          onSpeak={speakMessage}
        />
        {recordingSkill ? (
          <div className="px-6 pb-2 text-center text-[13px] text-[#EF4444]">
            <Trans>Teaching in progress — stop teaching before sending a new message.</Trans>
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
          runError={displayedRunError}
          runErrorId={displayedRunErrorId}
          onRunErrorPresented={handleRunErrorPresented}
          onDismissError={dismissComposerError}
          sending={sending}
          fileInputRef={fileInputRef}
          onAttachmentPick={onAttachmentPick}
          onRemoveAttachment={removeAttachment}
          onSend={sendMessage}
          onStop={stopRun}
          replyTarget={activeReplyTarget}
          replyTargetName={replyTargetName}
          onClearReply={() => setReplyTarget(null)}
          mentionTargets={composerMentionTargets}
          agentSkills={agentSkills}
          onSlashOpen={refreshAgentSkills}
          onSlashAction={(action) => {
            if (action === "chat-settings") {
              setPanel(inGroup ? "group-settings" : "settings");
              return;
            }
            if (action === "settings-general") {
              setAccountSettingsFocusUsage(false);
              setAccountSettingsOpen(true);
              return;
            }
            if (action === "settings-usage") {
              setAccountSettingsFocusUsage(true);
              setAccountSettingsOpen(true);
              void rpc.usage
                .summary()
                .then(setUsage)
                .catch(() => undefined);
            }
          }}
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
        className={`absolute inset-y-0 end-0 z-20 flex min-h-0 shrink-0 flex-col overflow-hidden bg-[#0A0A0B] transition-[width] duration-150 ease-out md:relative ${
          panel && (active || activeGroup)
            ? "w-full max-w-[384px] border-s border-[#141416] md:w-[384px] md:max-w-none"
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
                  {panel === "settings" ? (
                    <Trans>Settings</Trans>
                  ) : active ? (
                    (computer?.state ?? active.status)
                  ) : (
                    <Trans>Group</Trans>
                  )}
                </span>
                <div className="flex gap-3.5">
                  {active ? (
                    <button
                      type="button"
                      aria-label={panel === "settings" ? t`Show computer` : t`Show settings`}
                      onClick={() => setPanel(panel === "settings" ? "computer" : "settings")}
                      className={
                        panel === "settings"
                          ? "text-[#ECECEE]"
                          : "text-[#85858A] hover:text-[#ECECEE]"
                      }
                    >
                      <Settings size={16} strokeWidth={1.7} />
                    </button>
                  ) : null}
                  <button type="button" aria-label={t`Close panel`} onClick={() => setPanel(null)}>
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
                      <Trans>Open in full window</Trans>
                    </div>
                  ) : computer?.kind === "desktop" ? (
                    <div className="grid h-full place-items-center px-6 text-center text-sm text-[#6C6C70]">
                      <Trans>
                        This bot runs on this computer, not a Linux desktop. Shell and files use
                        your home folder.
                      </Trans>
                    </div>
                  ) : computer?.state === "running" && embeddedScreenUrl ? (
                    <iframe
                      title={t`Bot screen preview`}
                      src={embeddedScreenUrl}
                      sandbox={screenIframeSandbox(embeddedScreenUrl)}
                      className="h-full w-full border-0 bg-black"
                      allow="clipboard-read; clipboard-write"
                      style={{ pointerEvents: "none" }}
                    />
                  ) : (
                    <div className="grid h-full place-items-center px-6 text-center text-sm text-[#6C6C70]">
                      {computersAreUnavailable(bootstrapMe?.sandboxProvider) ? (
                        <ComputersUnavailableHint />
                      ) : (
                        computerPlaceholder(
                          computer?.state,
                          booting,
                          computerLabel(computer?.mode, active.name),
                        )
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    className="absolute inset-0 cursor-pointer"
                    aria-label={t`Open computer`}
                    onClick={() => void openComputer()}
                  />
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="min-w-0 text-[13.5px] text-[#85858A]">
                    {hasControl
                      ? t`You have control`
                      : computerError
                        ? computerError
                        : computer?.busyBotName
                          ? t`${computer.busyBotName} is using it`
                          : computer?.state === "suspended"
                            ? t`Asleep`
                            : computerLabel(computer?.mode, active.name)}
                  </span>
                  {hasControl ? (
                    <ComputerReleaseActions
                      takeoverRequested={computer?.takeoverRequested ?? false}
                      onRelease={releaseComputer}
                    />
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={takeoverBlocked}
                      title={takeoverBlocked ? t`Stop the bot first` : undefined}
                      onClick={() => void openComputer()}
                    >
                      <Trans>Take control</Trans>
                    </Button>
                  )}
                </div>
                {computer?.state === "error" ||
                computer?.state === "stopped" ||
                (computer?.state === "running" && !embeddedScreenUrl) ? (
                  <ComputerMaintenanceActions
                    botId={active.id}
                    computer={computer}
                    compact
                    onChanged={async () => {
                      await refreshThread(active.id);
                    }}
                  />
                ) : null}
                <RoutineListHeader
                  onCreate={() => {
                    setRoutineDraft(emptyRoutineDraft());
                    setRoutineWebhookSecret(null);
                    setEditingRoutine(null);
                    setRoutineError(null);
                    setPanel("routine");
                  }}
                />
                {activeRoutines.map((routine) => {
                  const routineRunning =
                    snapshot?.run?.routineId === routine.id && isActive(snapshot.run.status);
                  return (
                    <RoutineListRow
                      key={routine.id}
                      routine={routine}
                      running={routineRunning}
                      onOpen={() => {
                        setRoutineDraft(draftFromRoutine(routine));
                        setRoutineWebhookSecret(null);
                        setEditingRoutine(routine);
                        setRoutineError(null);
                        setPanel("routine");
                      }}
                      onStop={() => void stopRun()}
                    />
                  );
                })}
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
                        ...emptyRoutineDraft(),
                        name: skill.name || skill.goal.slice(0, 80),
                        prompt: `Run taught skill: ${skill.name || skill.goal}\n${skill.playbook.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
                      });
                      setRoutineWebhookSecret(null);
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
                onCreate={(input) => createGroup(input)}
              />
            ) : null}
            {panel === "group-settings" && activeGroup ? (
              <GroupSettings
                key={activeGroup.id}
                group={activeGroup}
                bots={bots}
                onSave={async (input) => {
                  const updated = await rpc.groups.update({ groupId: activeGroup.id, ...input });
                  setGroups((current) =>
                    current.map((group) => (group.id === updated.id ? updated : group)),
                  );
                  setPanel(null);
                  await Promise.all([refreshBots(), refreshGroupThread(activeGroup.id)]).catch(
                    () => undefined,
                  );
                }}
                onRemove={async () => {
                  await rpc.groups.remove({ groupId: activeGroup.id });
                  const remainingGroups = groups.filter((group) => group.id !== activeGroup.id);
                  setGroups(remainingGroups);
                  setPanel(null);
                  navigate(firstThreadRoute(bots, remainingGroups), { replace: true });
                  await refreshBots().catch(() => undefined);
                }}
              />
            ) : null}
            {panel === "create" ? (
              <CreateBotForm
                onCancel={() => setPanel(null)}
                onCreate={(input) => createBot(input)}
              />
            ) : null}
            {panel === "settings" && active ? (
              <BotSettings
                key={active.id}
                bot={active}
                computer={computer}
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
                onClear={() => setClearTarget({ kind: "bot", chat: active })}
                onComputerChanged={async () => {
                  await refreshThread(active.id);
                }}
              />
            ) : null}
            {panel === "routine" && active ? (
              <RoutineEditor
                draft={routineDraft}
                onChange={setRoutineDraft}
                editing={editingRoutine}
                timezone={editingRoutine?.timezone ?? localTimezone()}
                webhook={{
                  path:
                    typeof window !== "undefined"
                      ? `${window.location.origin}/api/v1/bots/${active.id}/webhook`
                      : `/api/v1/bots/${active.id}/webhook`,
                  secret: routineWebhookSecret,
                  configured: active.webhookConfigured || Boolean(routineWebhookSecret),
                }}
                saving={savingRoutine}
                running={runningRoutine}
                error={routineError}
                onBack={() => setPanel("computer")}
                onClose={() => setPanel(null)}
                onEnsureWebhook={async () => {
                  const result = await rpc.bots.rotateWebhookSecret({ botId: active.id });
                  setRoutineWebhookSecret(result.secret);
                  setBots((current) =>
                    current.map((bot) =>
                      bot.id === active.id ? { ...bot, webhookConfigured: true } : bot,
                    ),
                  );
                }}
                onSave={async () => {
                  if (routineSavePending.current) return;
                  const targetBotId = active.id;
                  const targetRoutine = editingRoutine;
                  if (targetRoutine && targetRoutine.botId !== targetBotId) return;
                  if (!routineDraft.schedules.length && !routineDraft.webhookEnabled) {
                    setRoutineError(t`Add a schedule or webhook trigger`);
                    return;
                  }
                  const saveRequest = ++routineSaveRequest.current;
                  routineSavePending.current = true;
                  setSavingRoutine(true);
                  setRoutineError(null);
                  try {
                    if (
                      routineDraft.webhookEnabled &&
                      !active.webhookConfigured &&
                      !routineWebhookSecret
                    ) {
                      const rotated = await rpc.bots.rotateWebhookSecret({ botId: targetBotId });
                      setRoutineWebhookSecret(rotated.secret);
                      setBots((current) =>
                        current.map((bot) =>
                          bot.id === targetBotId ? { ...bot, webhookConfigured: true } : bot,
                        ),
                      );
                    }
                    const crons = routineDraft.schedules.map(cronFromPreset);
                    let saved: Routine;
                    if (targetRoutine) {
                      const armOneShot = routineNeedsOneShotArm(targetRoutine, crons);
                      let runAt: string | undefined;
                      if (armOneShot) {
                        if (!routineDraft.runAtLocal) {
                          setRoutineError(t`Add a run time for this one-shot.`);
                          return;
                        }
                        const parsed = new Date(routineDraft.runAtLocal);
                        if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
                          setRoutineError(t`Run time must be in the future.`);
                          return;
                        }
                        runAt = parsed.toISOString();
                      }
                      saved = await rpc.routines.update({
                        routineId: targetRoutine.id,
                        name: routineDraft.name || t`Routine`,
                        prompt: routineDraft.prompt || t`Check in.`,
                        crons,
                        active: armOneShot ? true : routineDraft.active,
                        webhookEnabled: routineDraft.webhookEnabled,
                        ...(runAt ? { runAt } : {}),
                      });
                    } else {
                      saved = await rpc.routines.create({
                        botId: targetBotId,
                        name: routineDraft.name || t`Routine`,
                        prompt: routineDraft.prompt || t`Check in.`,
                        crons,
                        timezone: localTimezone(),
                        active: routineDraft.active,
                        notify: true,
                        webhookEnabled: routineDraft.webhookEnabled,
                      });
                    }
                    if (
                      routineSaveRequest.current === saveRequest &&
                      activeBotId.current === targetBotId
                    ) {
                      setEditingRoutine(saved);
                      setRoutineDraft(draftFromRoutine(saved));
                    }
                  } catch (error) {
                    if (
                      routineSaveRequest.current !== saveRequest ||
                      activeBotId.current !== targetBotId
                    ) {
                      return;
                    }
                    setRoutineError(
                      error instanceof Error ? error.message : t`Could not save routine`,
                    );
                    return;
                  } finally {
                    routineSavePending.current = false;
                    setSavingRoutine(false);
                  }
                  if (
                    routineSaveRequest.current !== saveRequest ||
                    activeBotId.current !== targetBotId
                  ) {
                    return;
                  }
                  await refreshThread(targetBotId).catch(() => undefined);
                }}
                onTestRun={async () => {
                  if (routineRunPending.current) return;
                  const targetBotId = active.id;
                  const targetRoutine = editingRoutine;
                  if (!targetRoutine) return;
                  routineRunPending.current = true;
                  setRunningRoutine(true);
                  setRoutineError(null);
                  try {
                    await rpc.routines.testRun({ routineId: targetRoutine.id });
                    await refreshThread(targetBotId);
                  } catch (error) {
                    if (activeBotId.current === targetBotId) {
                      setRoutineError(
                        error instanceof Error ? error.message : t`Could not run routine`,
                      );
                    }
                  } finally {
                    routineRunPending.current = false;
                    setRunningRoutine(false);
                  }
                }}
                onDelete={() => {
                  if (editingRoutine) {
                    setDeleteRoutineTarget(editingRoutine);
                    return;
                  }
                  setPanel("computer");
                }}
              />
            ) : null}
          </div>
        ) : null}
      </aside>

      <Suspense fallback={null}>
        {contextChat && botMenu ? (
          <BotContextMenu
            bot={contextChat}
            position={botMenu.position}
            onClose={closeBotMenu}
            sections={botSections}
            onTogglePinned={() => {
              setBotMenu(null);
              const request = contextBot
                ? rpc.bots.update({ botId: contextBot.id, pinned: !contextBot.pinned })
                : rpc.groups.update({
                    groupId: contextGroup!.id,
                    pinned: !contextGroup!.pinned,
                  });
              void request.then(() => refreshBots());
            }}
            onToggleUnread={() => {
              const unread = !contextChat.unread;
              setBotMenu(null);
              if (contextBot) {
                const request = unread ? markBotUnread(contextBot.id) : markBotRead(contextBot.id);
                void request.catch(() => undefined);
              } else {
                const request = unread
                  ? rpc.threads.markUnread({ groupId: contextGroup!.id })
                  : rpc.threads.markRead({ groupId: contextGroup!.id });
                void request
                  .then(() =>
                    setGroups((current) =>
                      current.map((group) =>
                        group.id === contextGroup!.id ? { ...group, unread } : group,
                      ),
                    ),
                  )
                  .catch(() => undefined);
              }
            }}
            onMoveToSection={(sectionId) => {
              setBotMenu(null);
              if (sectionId === contextChat.sectionId) return;
              const request = contextBot
                ? rpc.bots.update({ botId: contextBot.id, sectionId })
                : rpc.groups.update({ groupId: contextGroup!.id, sectionId });
              void request.then(() => refreshBots());
            }}
            onCreateSection={() => {
              setNewSectionTarget(
                contextBot
                  ? { kind: "bot", chat: contextBot }
                  : { kind: "group", chat: contextGroup! },
              );
              setBotMenu(null);
            }}
            onEdit={() => {
              navigate(contextBot ? `/app/${contextBot.id}` : `/app/g/${contextGroup!.id}`);
              setPanel(contextBot ? "settings" : "group-settings");
              setBotMenu(null);
            }}
            onDuplicate={() => {
              setBotMenu(null);
              const request = contextBot
                ? rpc.bots.duplicate({ botId: contextBot.id })
                : rpc.groups.duplicate({ groupId: contextGroup!.id });
              void request.then(async (chat) => {
                await refreshBots();
                navigate(contextBot ? `/app/${chat.id}` : `/app/g/${chat.id}`);
              });
            }}
            onClear={() => {
              setClearTarget(
                contextBot
                  ? { kind: "bot", chat: contextBot }
                  : { kind: "group", chat: contextGroup! },
              );
              setBotMenu(null);
            }}
            onArchive={() => {
              setBotMenu(null);
              const request = contextBot
                ? rpc.bots.archive({ botId: contextBot.id })
                : rpc.groups.archive({ groupId: contextGroup!.id });
              void request.then(() => refreshBots(true));
            }}
            onDelete={() => {
              if (contextBot) setDeleteTarget(contextBot);
              else setDeleteGroupTarget(contextGroup!);
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

        {deleteGroupTarget ? (
          <DeleteItemDialog
            item={deleteGroupTarget}
            noun="group"
            onCancel={() => setDeleteGroupTarget(null)}
            onConfirm={async () => {
              await rpc.groups.remove({ groupId: deleteGroupTarget.id });
              setDeleteGroupTarget(null);
              setPanel(null);
              await refreshBots(true);
            }}
          />
        ) : null}

        {newSectionTarget ? (
          <NewBotSectionDialog
            bot={newSectionTarget.chat}
            onCancel={() => setNewSectionTarget(null)}
            onConfirm={async (name) => {
              await rpc.botSections.create(
                newSectionTarget.kind === "bot"
                  ? { botId: newSectionTarget.chat.id, name }
                  : { groupId: newSectionTarget.chat.id, name },
              );
              setNewSectionTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {newSpaceOpen ? (
          <NewSpaceDialog
            onCancel={() => setNewSpaceOpen(false)}
            onConfirm={async (name) => {
              const space = await rpc.spaces.create({ name });
              if (!selectSpace(space.id)) {
                setNewSpaceOpen(false);
                await refreshBots();
                return;
              }
              window.location.assign("/onboarding");
            }}
          />
        ) : null}

        {clearTarget ? (
          <ClearConversationDialog
            bot={clearTarget.chat}
            onCancel={() => setClearTarget(null)}
            onConfirm={async () => {
              await rpc.threads.clear(
                clearTarget.kind === "bot"
                  ? { botId: clearTarget.chat.id }
                  : { groupId: clearTarget.chat.id },
              );
              if (
                (clearTarget.kind === "bot" && active?.id === clearTarget.chat.id) ||
                (clearTarget.kind === "group" && activeGroup?.id === clearTarget.chat.id)
              ) {
                expandedHistoryThread.current = null;
                pinnedAroundRef.current = null;
                historyEpoch.current += 1;
                updateSnapshot((current) =>
                  current ? { ...current, messages: [], olderCursor: null, run: null } : current,
                );
              }
              setClearTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {deleteRoutineTarget ? (
          <DeleteItemDialog
            item={deleteRoutineTarget}
            noun="routine"
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

        {pluginsOpen ? (
          <PluginsOverlay
            activeBotId={activeBotId.current}
            onClose={() => setPluginsOpen(false)}
            onOpenMcp={() => {
              setPluginsOpen(false);
              setMcpOpen(true);
            }}
          />
        ) : null}
        {mcpOpen ? <McpServersOverlay onClose={() => setMcpOpen(false)} /> : null}
        {messagingSettingsOpen ? (
          <MessagingSettingsOverlay onClose={() => setMessagingSettingsOpen(false)} />
        ) : null}
      </Suspense>

      <Suspense fallback={null}>
        {accountSettingsOpen ? (
          <AccountSettingsOverlay
            name={userName}
            email={session.data?.user.email}
            usage={usage}
            focusUsage={accountSettingsFocusUsage}
            avatarStyle={bootstrapMe?.avatarStyle ?? "robot"}
            isDeploymentOwner={bootstrapMe?.isDeploymentOwner === true}
            sandboxProvider={bootstrapMe?.sandboxProvider}
            messagingEnabled={messagingSurfaceEnabled}
            onOpenMessaging={() => {
              setAccountSettingsOpen(false);
              setMessagingSettingsOpen(true);
            }}
            onAvatarStyleChange={async (avatarStyle) => {
              const nextMe = await rpc.preferences.update({ avatarStyle });
              setBootstrapMe(nextMe);
            }}
            onClose={() => {
              setAccountSettingsOpen(false);
              setAccountSettingsFocusUsage(false);
            }}
          />
        ) : null}
        {modelsOpen ? <ModelSettingsOverlay onClose={() => setModelsOpen(false)} /> : null}
        {peerConversation && active ? (
          <PeerMessagesOverlay
            botId={active.id}
            botName={active.name}
            botColor={active.color}
            peerBotId={peerConversation.peerBotId}
            peerBotName={peerConversation.peerBotName}
            peerBotColor={resolveTranscriptBot(peerConversation.peerBotId)?.color ?? "#85858A"}
            onClose={() => setPeerConversation(null)}
          />
        ) : null}
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
            <Trans>Booting up {active?.name}’s computer</Trans>
          </div>
          <div className="h-[5px] w-[min(420px,70%)] overflow-hidden rounded-full bg-[#232327]">
            <div className="h-full w-2/3 rounded-full bg-[#F1F1EF]" />
          </div>
        </div>
      ) : computerOpen && active ? (
        <div className="absolute inset-0 z-30 flex flex-col bg-[#050506]">
          <div className="flex items-center justify-between gap-4 border-b border-[#171719] px-[18px] py-3.5">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <BotAvatar
                color={active.color}
                identity={active.id}
                size={28}
                status={active.status}
              />
              {recordingSkill ? (
                <TeachRecordingChrome
                  recording={recordingSkill}
                  busy={teachBusy}
                  onStop={stopTeaching}
                  variant="overlay"
                />
              ) : (
                <span className="truncate text-[15.5px] font-medium text-[#ECECEE]" dir="auto">
                  {computerLabel(computer?.mode, active.name)}
                </span>
              )}
              {!recordingSkill && hasControl ? (
                <span className="rounded-full bg-[rgba(48,162,75,.14)] px-[11px] py-1 text-[13px] text-[#4ECB71]">
                  <Trans>You have control</Trans>
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              {composerRunning ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t`Stop`}
                  data-testid="computer-overlay-stop"
                  onClick={() => void stopRun()}
                  disabled={sending}
                >
                  <Trans>Stop</Trans>
                </Button>
              ) : null}
              {recordingSkill ? (
                <TeachStopButton busy={teachBusy} onStop={stopTeaching} />
              ) : hasControl ? (
                <ComputerReleaseActions
                  takeoverRequested={computer?.takeoverRequested ?? false}
                  onRelease={releaseComputer}
                />
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={takeoverBlocked}
                  title={takeoverBlocked ? t`Stop the bot first` : undefined}
                  onClick={() =>
                    void bootComputer({ takeControl: true, overlay: false }).catch(() => undefined)
                  }
                >
                  <Trans>Take control</Trans>
                </Button>
              )}
              <button
                type="button"
                className="text-[16px] text-[#85858A] hover:text-[#ECECEE]"
                aria-label={t`Close computer`}
                onClick={() => setComputerOpen(false)}
              >
                <X size={16} strokeWidth={1.8} />
              </button>
            </div>
          </div>
          {sendError ? (
            <div
              role="alert"
              className="border-b border-[#5A2A2A] bg-[#2A1717] px-[18px] py-2 text-[13px] text-[#FCA5A5]"
            >
              {sendError}
            </div>
          ) : null}
          <div className="relative min-h-0 flex-1 bg-[#0E0E10]">
            {computer?.kind === "desktop" ? (
              <div className="grid h-full place-items-center px-8 text-center text-sm text-[#6C6C70]">
                <Trans>
                  This bot runs on this computer. There is no separate Linux desktop. Ask it to use
                  the shell; working directories under your home folder are allowed.
                </Trans>
              </div>
            ) : computer?.state === "running" && embeddedScreenUrl ? (
              <>
                <iframe
                  title={t`Bot screen`}
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
                  ? t`Computer is asleep`
                  : computerLabel(computer?.mode, active.name)}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <AvatarStyleProvider value={bootstrapMe?.avatarStyle ?? "robot"}>{shell}</AvatarStyleProvider>
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
  workingBots,
  onLoadOlder,
  onOpenBot,
  onAnswer,
  onReply,
  onReact,
  onJumpToMessage,
  onOpenPeerMessages,
  memberName,
  peerBot,
  onRefresh,
  onBotChanged,
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
  workingBots: GroupAvatarMember[];
  onLoadOlder: () => void | Promise<void>;
  onOpenBot: (botId: string) => void;
  onAnswer: (message: ThreadMessage, text: string) => Promise<void>;
  onReply: (message: ThreadMessage) => void;
  onReact: (message: ThreadMessage) => Promise<void>;
  onJumpToMessage: (messageId: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (botId: string) => { color: string; status?: string } | undefined;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speakingMessageId: string | null;
  onSpeak: (message: ThreadMessage) => void;
}) {
  const { t } = useLingui();
  const [atEnd, setAtEnd] = useState(true);
  const following = useRef(true);
  const autoScrolling = useRef(false);
  const lastScrollTop = useRef<number | null>(null);
  const autoScrollTimer = useRef<number | undefined>(undefined);
  const jumpButtonRef = useRef<HTMLButtonElement>(null);
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const workingBotName = workingBots.length === 1 ? workingBots[0]?.name : undefined;
  const workingLabel =
    workingBotName != null && workingBotName !== ""
      ? t`${workingBotName} is working`
      : t`Bots are working`;
  const snapToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    following.current = true;
    autoScrolling.current = false;
    setAtEnd(true);
    element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
  }, [scrollRef]);

  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    following.current = true;
    autoScrolling.current = !reducedMotion;
    setAtEnd(true);
    element.scrollTo({
      top: element.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
    window.clearTimeout(autoScrollTimer.current);
    // Fallback only: onScroll clears autoScrolling once near-end is reached.
    autoScrollTimer.current = window.setTimeout(
      () => {
        autoScrolling.current = false;
      },
      reducedMotion ? 0 : 2_000,
    );
  }, [scrollRef]);

  useLayoutEffect(() => {
    if (following.current) snapToEnd();
  }, [messages, running, snapToEnd]);

  useLayoutEffect(() => {
    const button = jumpButtonRef.current;
    if (atEnd && button && document.activeElement === button) {
      button.blur();
    }
  }, [atEnd]);

  const loadOlder = useCallback(() => {
    const wasFollowing = following.current;
    // Prepend must not race the messages-driven snap-to-end follow path.
    following.current = false;
    autoScrolling.current = false;
    const pending = onLoadOlder();
    if (!pending) return;
    return Promise.resolve(pending).catch((error) => {
      const element = scrollRef.current;
      if (wasFollowing && element && transcriptIsNearEnd(element)) {
        following.current = true;
        setAtEnd(true);
      }
      throw error;
    });
  }, [onLoadOlder, scrollRef]);

  useEffect(
    () => () => {
      window.clearTimeout(autoScrollTimer.current);
    },
    [],
  );

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-testid="transcript"
        onPointerDown={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
        }}
        onTouchStart={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) {
            lastScrollTop.current = event.currentTarget.scrollTop;
            autoScrolling.current = false;
            following.current = false;
          }
        }}
        onScroll={(event) => {
          const scrolledDown = transcriptMovedDown(
            lastScrollTop.current,
            event.currentTarget.scrollTop,
          );
          lastScrollTop.current = event.currentTarget.scrollTop;
          const nearEnd = transcriptIsNearEnd(event.currentTarget);
          setAtEnd(nearEnd);
          if (nearEnd) {
            if (scrolledDown) following.current = true;
            if (autoScrolling.current) {
              autoScrolling.current = false;
              window.clearTimeout(autoScrollTimer.current);
            }
          } else if (!autoScrolling.current) {
            following.current = false;
          }
        }}
        className="rk-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-5 md:px-7 md:py-6"
      >
        {olderCursor != null ? (
          <button
            type="button"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
            className="self-center rounded-lg px-3 py-1.5 text-[13px] text-[#85858A] hover:bg-[#1A1A1D] hover:text-[#C9C9CE] disabled:opacity-50"
          >
            {loadingOlder ? t`Loading…` : t`Load earlier messages`}
          </button>
        ) : null}
        {messages.map((message) => {
          const peerReceipt = isPeerReceiptBlocks(message.blocks);
          return (
            <div
              key={message.id}
              data-message-id={message.id}
              className={peerReceipt ? "relative py-0.5" : "group/message relative pt-9 hover:z-20"}
            >
              {peerReceipt ? null : (
                <MessageHoverActions message={message} onReply={onReply} onReact={onReact} />
              )}
              <MessageView
                artifactTarget={artifactTarget}
                message={message}
                canAnswer={message.id === answerableAskMessageId}
                onOpenBot={onOpenBot}
                onOpenPeerMessages={onOpenPeerMessages}
                onAnswer={onAnswer}
                speakerName={
                  peerReceipt
                    ? undefined
                    : message.role === "bot"
                      ? memberName?.(message.botId)
                      : undefined
                }
                memberName={memberName}
                peerBot={peerBot}
                replyPreview={
                  message.replyToMessageId ? messageById.get(message.replyToMessageId) : undefined
                }
                replyToMessageId={message.replyToMessageId}
                onJumpToMessage={onJumpToMessage}
                onRefresh={onRefresh}
                onBotChanged={onBotChanged}
                onAddRoutine={onAddRoutine}
                voiceReady={voiceReady}
                speaking={speakingMessageId === message.id}
                onSpeak={() => onSpeak(message)}
              />
              {!peerReceipt && message.thumbsUp ? (
                <button
                  type="button"
                  aria-label={t`Remove thumbs-up`}
                  onClick={() => void onReact(message)}
                  className={`mt-1 rounded-full border border-[#303034] bg-[#1A1A1D] px-2 py-0.5 text-xs ${
                    message.role === "user" ? "ml-auto block" : ""
                  }`}
                >
                  👍
                </button>
              ) : null}
            </div>
          );
        })}
        {running &&
        !messages.some(
          (message) =>
            message.id.startsWith("progress:") &&
            message.blocks[0]?.kind === "progress" &&
            message.blocks[0].text,
        ) ? (
          <ActiveBotGlyph bots={workingBots} label={workingLabel} />
        ) : null}
      </div>
      <button
        ref={jumpButtonRef}
        type="button"
        aria-label={t`Jump to latest`}
        aria-hidden={atEnd}
        tabIndex={atEnd ? -1 : 0}
        onClick={jumpToLatest}
        className={`absolute bottom-4 left-1/2 z-20 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full border border-[#303034] bg-[#1A1A1D]/95 text-[#C9C9CE] shadow-[0_8px_24px_rgba(0,0,0,.45)] backdrop-blur transition-[opacity,transform,background-color] duration-200 ease-[cubic-bezier(.22,1,.36,1)] hover:bg-[#242428] motion-reduce:transition-none ${
          atEnd ? "pointer-events-none translate-y-2 opacity-0" : "translate-y-0 opacity-100"
        }`}
      >
        <ArrowDown size={17} strokeWidth={1.8} />
      </button>
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
  runError,
  runErrorId,
  onRunErrorPresented,
  onDismissError,
  sending,
  fileInputRef,
  onAttachmentPick,
  onRemoveAttachment,
  onSend,
  onStop,
  replyTarget,
  replyTargetName,
  onClearReply,
  mentionTargets,
  agentSkills,
  onSlashOpen,
  onSlashAction,
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
  runError: string | null;
  runErrorId: string | null;
  onRunErrorPresented: (runId: string) => void;
  onDismissError: () => void;
  sending: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAttachmentPick: (files: FileList | null) => void | Promise<void>;
  onRemoveAttachment: (attachment: PendingAttachment) => void;
  onSend: (text: string, mentions?: ComposerMention[]) => Promise<void>;
  onStop: () => Promise<void>;
  replyTarget?: ThreadMessage | null;
  replyTargetName?: string;
  onClearReply?: () => void;
  mentionTargets?: ComposerMention[];
  agentSkills?: AgentSkillCatalogEntry[];
  onSlashOpen?: () => void;
  onSlashAction?: (action: SlashActionId) => void;
  dictating: boolean;
  transcribe: boolean;
  onDictateStart: (onFinal: (text: string) => void) => void;
  onDictateStop: () => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionHighlightIndex, setMentionHighlightIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<ComposerMention[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const runErrorRef = useRef<HTMLDivElement>(null);
  const presentedRunErrorIdRef = useRef<string | null>(null);
  const mentionListboxId = useId();
  const dragDepth = useRef(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const canSend =
    draft.trim().length > 0 ||
    selectedSkill !== null ||
    selectedMentions.length > 0 ||
    pendingAttachments.length > 0;

  useEffect(() => {
    if (!runError || !runErrorId) return;
    const currentRunErrorId = runErrorId;
    let frame = 0;
    function recordIfPresented() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = runErrorRef.current;
        if (!element || document.visibilityState !== "visible") return;
        const rect = element.getBoundingClientRect();
        const topElement = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        if (topElement && (topElement === element || element.contains(topElement))) {
          if (presentedRunErrorIdRef.current === currentRunErrorId) return;
          presentedRunErrorIdRef.current = currentRunErrorId;
          onRunErrorPresented(currentRunErrorId);
        }
      });
    }
    recordIfPresented();
    const observer = new MutationObserver(recordIfPresented);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("transitionend", recordIfPresented);
    document.addEventListener("visibilitychange", recordIfPresented);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("transitionend", recordIfPresented);
      document.removeEventListener("visibilitychange", recordIfPresented);
    };
  }, [onRunErrorPresented, runError, runErrorId]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    function syncHeight() {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = "0px";
      textarea.style.height = `${textarea.scrollHeight}px`;
    }

    syncHeight();
    let lastWidth = el.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const width = textarea.getBoundingClientRect().width;
      if (width === lastWidth) return;
      lastWidth = width;
      syncHeight();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [draft]);

  function updateDraft(value: string) {
    setDraft(value);
    const mentionMatch = /(?:^|\s)@([\w-]*)$/.exec(value);
    setMentionQuery(mentionMatch ? (mentionMatch[1] ?? "") : null);
    // `/` only at the start of the draft so forced skills expand (`Use skill:` / `/Name` prefix).
    const slashMatch = selectedSkill === null ? /^\/([^\n]*)$/.exec(value) : null;
    const nextSlash = slashMatch ? (slashMatch[1] ?? "") : null;
    if (nextSlash !== null && slashQuery === null) onSlashOpen?.();
    setSlashQuery(nextSlash);
  }

  function focusComposer() {
    textareaRef.current?.focus();
  }

  function insertMention(mention: ComposerMention) {
    setDraft((current) => current.replace(/@([\w-]*)$/, ""));
    setMentionQuery(null);
    setMentionHighlightIndex(0);
    setSelectedMentions((current) =>
      current.some((selected) => mentionChipKey(selected) === mentionChipKey(mention))
        ? current
        : [...current, mention],
    );
    focusComposer();
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    setSelectedSkill(skill);
    setDraft("");
    setSlashQuery(null);
  }

  function runSlashAction(action: SlashActionId) {
    setDraft("");
    setSlashQuery(null);
    onSlashAction?.(action);
  }

  function removeLastChip() {
    if (selectedMentions.length > 0) {
      setSelectedMentions((current) => current.slice(0, -1));
      return;
    }
    if (selectedSkill) setSelectedSkill(null);
  }

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || !mentionTargets?.length) return [];
    const query = mentionQuery.trim().toLowerCase();
    return mentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [mentionQuery, mentionTargets]);

  useEffect(() => {
    setMentionHighlightIndex(0);
  }, [mentionQuery, mentionOptions]);

  const activeMentionIndex = clampMentionHighlightIndex(
    mentionHighlightIndex,
    mentionOptions.length,
  );
  const mentionPickerOpen = mentionOptions.length > 0;
  const activeMentionOptionId = mentionPickerOpen
    ? `${mentionListboxId}-option-${activeMentionIndex}`
    : undefined;

  const slashSkillOptions = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    const skills = agentSkills ?? [];
    return skills
      .filter((skill) => {
        if (!query) return true;
        return (
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query)
        );
      })
      .slice(0, 8);
  }, [agentSkills, slashQuery]);

  const slashActionOptions = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    return SLASH_ACTIONS.filter((action) => !query || action.label.toLowerCase().includes(query));
  }, [slashQuery]);

  const showSlashPicker =
    slashQuery !== null &&
    mentionQuery === null &&
    (slashSkillOptions.length > 0 || slashActionOptions.length > 0);

  function send() {
    if (!canSend || sending || disabled) return;
    const text = serializeComposerPrompt(draft, selectedSkill, selectedMentions);
    setDraft("");
    setMentionQuery(null);
    setMentionHighlightIndex(0);
    setSlashQuery(null);
    setSelectedSkill(null);
    const mentions = selectedMentions;
    setSelectedMentions([]);
    void onSend(text, mentions);
  }

  function handleDragEnter(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current += 1;
    setDraggingFiles(true);
  }

  function handleDragOver(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    setDraggingFiles(true);
  }

  function handleDragLeave(event: DragEvent<HTMLFieldSetElement>) {
    if (!isFileDrag(event.dataTransfer)) return;
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDraggingFiles(false);
  }

  function handleDrop(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDraggingFiles(false);
    if (!disabled) void onAttachmentPick(dataTransfer.files);
  }

  const showComposerPlaceholder =
    draft.length === 0 && selectedSkill === null && selectedMentions.length === 0;
  const replyName = replyTarget ? (replyTargetName ?? previewMessageText(replyTarget)) : "";

  return (
    <fieldset
      aria-label={t`Message composer`}
      data-dragging={draggingFiles ? "files" : undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative z-30 m-0 min-w-0 border-0 px-3 pb-4 pt-3 md:px-6 md:pb-6 ${
        draggingFiles ? "rounded-[14px] ring-2 ring-inset ring-[#8B5CF6]" : ""
      }`}
    >
      {sendError || dictationError || runError ? (
        <div
          ref={runErrorRef}
          role="alert"
          data-testid="composer-error"
          className="mb-3 flex items-center gap-2 rounded-[14px] border border-[#5A2A2A] bg-[#2A1717] px-4 py-2 text-[13px] text-[#FCA5A5]"
        >
          <span className="min-w-0 flex-1">{sendError ?? dictationError ?? runError}</span>
          <button
            type="button"
            aria-label={t`Dismiss error`}
            data-testid="composer-error-dismiss"
            onClick={() => {
              onDismissError();
              window.requestAnimationFrame(() => textareaRef.current?.focus());
            }}
            className="shrink-0 text-[#FCA5A5] hover:text-[#ECECEE]"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : null}
      {replyTarget ? (
        <div
          data-testid="reply-chip"
          className="mb-2 flex items-center gap-2 rounded-full border border-[#26262A] bg-[#17171A] px-3 py-1.5 text-[13px] text-[#C9C9CE]"
        >
          <span className="min-w-0 flex-1 truncate text-[#85858A]">{t`Replying to ${replyName}`}</span>
          <button
            type="button"
            aria-label={t`Cancel reply`}
            onClick={onClearReply}
            className="shrink-0 text-[#85858A] hover:text-[#ECECEE]"
          >
            <X size={13} strokeWidth={2} />
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
              <span className="max-w-[180px] truncate" dir="auto">
                {attachment.file.name}
              </span>
              <button
                type="button"
                aria-label={t`Remove ${attachment.file.name}`}
                onClick={() => onRemoveAttachment(attachment)}
                className="text-[#85858A] hover:text-[#ECECEE]"
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {mentionPickerOpen ? (
        <div
          id={mentionListboxId}
          role="listbox"
          aria-label={t`Mentions`}
          data-testid="mention-picker"
          className="mb-2 overflow-hidden rounded-[14px] border border-[#26262A] bg-[#17171A]"
        >
          {mentionOptions.map((mention, index) => {
            const optionId = `${mentionListboxId}-option-${index}`;
            const highlighted = index === activeMentionIndex;
            return (
              <button
                id={optionId}
                key={mentionChipKey(mention)}
                type="button"
                role="option"
                aria-selected={highlighted}
                aria-label={t`@${mention.name}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMention(mention)}
                onMouseEnter={() => setMentionHighlightIndex(index)}
                className={`flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-[#1F1F22] ${
                  highlighted ? "bg-[#1F1F22]" : ""
                }`}
              >
                <MentionOptionIcon mention={mention} />
                <span className="min-w-0">
                  <span dir="auto" className="block text-[14px] text-[#ECECEE]">
                    @{mention.name}
                  </span>
                  {mention.subtitle ? (
                    <span dir="auto" className="block truncate text-[12.5px] text-[#85858A]">
                      {mention.subtitle}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {showSlashPicker ? (
        <div
          data-testid="slash-picker"
          className="mb-2 overflow-hidden rounded-[14px] border border-[#26262A] bg-[#17171A]"
        >
          {slashSkillOptions.map((skill) => (
            <button
              key={skill.id}
              type="button"
              aria-label={t`Skill ${skill.name}`}
              onClick={() => insertSkill(skill)}
              className="flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-[#1F1F22]"
            >
              <Box size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-[#9A9AA0]" />
              <span className="min-w-0">
                <span dir="auto" className="block text-[14px] text-[#ECECEE]">
                  {skill.name}
                </span>
                <span dir="auto" className="block truncate text-[12.5px] text-[#85858A]">
                  {truncateSlashDescription(skill.description)}
                </span>
              </span>
            </button>
          ))}
          {slashActionOptions.map((action) => {
            const label = slashActionLabel(action.id);
            return (
              <button
                key={action.id}
                type="button"
                aria-label={label}
                onClick={() => runSlashAction(action.id)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-[#1F1F22]"
              >
                <Settings size={16} strokeWidth={1.7} className="shrink-0 text-[#9A9AA0]" />
                <span className="text-[14px] text-[#ECECEE]">{label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        data-testid="composer-bar"
        className="flex items-center gap-3.5 rounded-full border border-[#202023] bg-[#131315] py-[9px] pe-2.5 ps-3"
      >
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
          aria-label={t`Attach file`}
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full border border-[#26262A] text-[#9A9AA0] disabled:opacity-40"
        >
          <Plus size={17} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          aria-label={dictating ? t`Stop dictation` : t`Dictate`}
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
          title={transcribe ? t`Hold to talk` : t`Hold to talk (on-device dictation)`}
        >
          <Mic size={16} strokeWidth={1.8} />
        </button>
        <div className="flex min-w-0 flex-1 flex-wrap items-end gap-1.5">
          {selectedSkill ? (
            <span
              data-testid="skill-chip"
              className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-[#1C1C1F] px-2.5 py-1 text-[13px] text-[#ECECEE]"
            >
              <Box size={13} strokeWidth={1.7} className="shrink-0 text-[#B0B0B6]" />
              <span dir="auto" className="truncate">
                {selectedSkill.name}
              </span>
              <button
                type="button"
                aria-label={t`Remove skill ${selectedSkill.name}`}
                onClick={() => setSelectedSkill(null)}
                className="text-[#85858A] hover:text-[#ECECEE]"
              >
                <X size={12} strokeWidth={2} />
              </button>
            </span>
          ) : null}
          {selectedMentions.map((mention) => (
            <span
              key={mentionChipKey(mention)}
              data-testid="mention-chip"
              data-mention-kind={mention.kind}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-[#1C1C1F] px-2.5 py-1 text-[13px] text-[#ECECEE]"
            >
              <MentionChipIcon mention={mention} />
              <span dir="auto" className="truncate">
                {mention.name}
              </span>
              <button
                type="button"
                aria-label={t`Remove mention ${mention.name}`}
                onClick={() =>
                  setSelectedMentions((current) =>
                    current.filter(
                      (selected) => mentionChipKey(selected) !== mentionChipKey(mention),
                    ),
                  )
                }
                className="text-[#85858A] hover:text-[#ECECEE]"
              >
                <X size={12} strokeWidth={2} />
              </button>
            </span>
          ))}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Backspace" &&
                draft.length === 0 &&
                (selectedSkill !== null || selectedMentions.length > 0)
              ) {
                event.preventDefault();
                removeLastChip();
                return;
              }
              const action = resolveMentionPickerKey({
                key: event.key,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
                optionCount: mentionOptions.length,
                highlightedIndex: activeMentionIndex,
              });
              if (action.type === "complete") {
                const mention = mentionOptions[action.index];
                if (!mention) return;
                event.preventDefault();
                insertMention(mention);
                return;
              }
              if (action.type === "move") {
                event.preventDefault();
                setMentionHighlightIndex(action.index);
                return;
              }
              if (action.type === "dismiss") {
                event.preventDefault();
                setMentionQuery(null);
                setMentionHighlightIndex(0);
                return;
              }
              if (action.type === "send") {
                event.preventDefault();
                send();
              }
            }}
            disabled={disabled}
            placeholder={
              showComposerPlaceholder
                ? activeName
                  ? t`Message ${activeName}`
                  : t`Message…`
                : undefined
            }
            aria-label={activeName ? t`Message ${activeName}` : t`Message`}
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={mentionPickerOpen}
            aria-controls={mentionPickerOpen ? mentionListboxId : undefined}
            aria-activedescendant={activeMentionOptionId}
            name="chat-message"
            autoComplete="off"
            dir="auto"
            rows={1}
            className="max-h-32 min-h-[24px] min-w-[8rem] flex-1 resize-none overflow-y-auto bg-transparent py-0.5 text-[15.5px] leading-6 text-[#E9E9EA] outline-none disabled:opacity-40"
          />
        </div>
        {running ? (
          <>
            <button
              type="button"
              aria-label={t`Send`}
              disabled={sending || !canSend || disabled}
              onClick={send}
              className="grid h-10 w-10 place-items-center rounded-full bg-[#F1F1EF] text-[#17171A] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A6A6AD] disabled:opacity-50"
            >
              <ArrowUp size={18} strokeWidth={2} />
            </button>
            <button
              type="button"
              aria-label={t`Stop`}
              disabled={sending}
              onClick={() => void onStop()}
              className="grid h-10 w-10 place-items-center rounded-full border border-[#34343A] text-[#C9C9CE] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A6A6AD] disabled:opacity-50"
            >
              <Square size={12} strokeWidth={0} fill="currentColor" />
            </button>
          </>
        ) : (
          <button
            type="button"
            aria-label={t`Send`}
            disabled={sending || !canSend || disabled}
            onClick={send}
            className="grid h-9 w-9 place-items-center rounded-full bg-[#F1F1EF] text-[#17171A] disabled:opacity-50"
          >
            <ArrowUp size={18} strokeWidth={2} />
          </button>
        )}
      </div>
    </fieldset>
  );
});

function slashActionLabel(id: SlashActionId) {
  switch (id) {
    case "chat-settings":
      return t`Chat Settings`;
    case "settings-general":
      return t`Settings: General`;
    case "settings-usage":
      return t`Settings: Usage`;
  }
}

function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <Clock size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-[#9A9AA0]" />;
  }
  if (mention.kind === "connector") {
    return <Puzzle size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-[#9A9AA0]" />;
  }
  if (mention.kind === "group") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[#2A2A2E] text-[9px] text-[#C9C9CE]">
        G
      </span>
    );
  }
  if (mention.kind === "everyone") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[#2A2A2E] text-[9px] text-[#C9C9CE]">
        @
      </span>
    );
  }
  return <BotAvatar color={mention.color ?? "#85858A"} identity={mention.id} size={16} />;
}

function MentionChipIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <Clock size={13} strokeWidth={1.7} className="shrink-0 text-[#B0B0B6]" />;
  }
  if (mention.kind === "connector") {
    return <Puzzle size={13} strokeWidth={1.7} className="shrink-0 text-[#B0B0B6]" />;
  }
  if (mention.kind === "group" || mention.kind === "everyone") {
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[#2A2A2E] text-[9px] text-[#C9C9CE]">
        {mention.kind === "group" ? "G" : "@"}
      </span>
    );
  }
  return <BotAvatar color={mention.color ?? "#85858A"} identity={mention.id} size={16} />;
}

function previewMessageText(message: ThreadMessage): string {
  const text = message.blocks
    .map((block) => (block.kind === "text" || block.kind === "channel_message" ? block.text : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
  if (text) return text;
  if (message.blocks.some((block) => block.kind === "image" || block.kind === "file")) {
    return t`Attachment`;
  }
  return t`Message`;
}

function MessageHoverActions({
  message,
  onReply,
  onReact,
}: {
  message: ThreadMessage;
  onReply: (message: ThreadMessage) => void;
  onReact: (message: ThreadMessage) => Promise<void>;
}) {
  const { t } = useLingui();
  // Streaming progress bubbles keep hover free for selection / stop clicks.
  if (message.id.startsWith("progress:")) return null;

  function copyMessage() {
    const text = copyableMessageText(message);
    if (!text || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text).catch(() => undefined);
  }

  return (
    <MessageHoverMetadata createdAt={message.createdAt}>
      <div
        data-testid="message-hover-actions"
        className="flex items-center gap-0.5 rounded-full bg-[#1C1C1F] p-0.5 shadow-[0_1px_4px_rgba(0,0,0,0.45)]"
      >
        <button
          type="button"
          aria-label={t`Reply`}
          onClick={() => onReply(message)}
          className="grid h-7 w-7 place-items-center rounded-full text-[#C9C9CE] hover:bg-[#2A2A2F] hover:text-[#ECECEE]"
        >
          <Reply size={14} strokeWidth={1.8} />
        </button>
        {canReactToThreadMessage(message) ? (
          <button
            type="button"
            aria-label={message.thumbsUp ? t`Remove thumbs-up` : t`Add thumbs-up`}
            aria-pressed={Boolean(message.thumbsUp)}
            onClick={() => void onReact(message)}
            className={`grid h-7 w-7 place-items-center rounded-full hover:bg-[#2A2A2F] hover:text-[#ECECEE] ${
              message.thumbsUp ? "text-[#E9C46A]" : "text-[#C9C9CE]"
            }`}
          >
            <ThumbsUp size={14} strokeWidth={1.8} />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={t`Copy`}
          onClick={copyMessage}
          className="grid h-7 w-7 place-items-center rounded-full text-[#C9C9CE] hover:bg-[#2A2A2F] hover:text-[#ECECEE]"
        >
          <Copy size={14} strokeWidth={1.8} />
        </button>
      </div>
    </MessageHoverMetadata>
  );
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
  commitSnapshot: (next: ThreadSnapshot | null) => void,
  commitComputer: (next: ComputerStatus | null) => void,
  snapshotRef: MutableRefObject<ThreadSnapshot | null>,
  computerRef: MutableRefObject<ComputerStatus | null>,
) {
  if (isThreadSnapshotEvent(event)) {
    const next = reduceThreadSnapshot(snapshotRef.current, event);
    commitSnapshot(next);
  }
  if (isComputerStatusEvent(event)) {
    const next = reduceComputerStatus(computerRef.current, event);
    commitComputer(next);
  }
}

function ComputerReleaseActions({
  takeoverRequested,
  onRelease,
}: {
  takeoverRequested: boolean;
  onRelease: (reason?: ComputerReleaseReason) => Promise<void>;
}) {
  if (!takeoverRequested) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => void onRelease()}>
        <Trans>Release</Trans>
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => void onRelease("skipped")}>
        <Trans>Skip</Trans>
      </Button>
      <Button type="button" size="sm" onClick={() => void onRelease("done")}>
        <Trans>I’m done</Trans>
      </Button>
    </div>
  );
}

const MessageView = memo(function MessageView({
  artifactTarget,
  canAnswer,
  message,
  onAnswer,
  onOpenBot,
  onOpenPeerMessages,
  speakerName,
  memberName,
  peerBot,
  replyPreview,
  replyToMessageId,
  onJumpToMessage,
  onRefresh,
  onBotChanged,
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
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  speakerName?: string;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (botId: string) => { color: string; status?: string } | undefined;
  replyPreview?: ThreadMessage;
  replyToMessageId?: string;
  onJumpToMessage?: (messageId: string) => void;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speaking: boolean;
  onSpeak: () => void;
}) {
  const { t } = useLingui();
  const isNarration =
    message.role === "bot" &&
    message.blocks.length > 0 &&
    message.blocks.every(
      (block) => block.kind === "text" || block.kind === "progress" || block.kind === "steps",
    );
  const isLive = message.id.startsWith("progress:");
  const parentJumpId = replyPreview?.id ?? replyToMessageId;
  const messageContext = (
    <>
      {speakerName ? (
        <div className="mb-1 text-[12.5px] font-medium text-[#85858A]" dir="auto">
          {speakerName}
        </div>
      ) : null}
      {parentJumpId ? (
        <button
          type="button"
          data-testid="reply-parent-preview"
          aria-label={t`Jump to replied message`}
          onClick={() => onJumpToMessage?.(parentJumpId)}
          className="mb-2 block max-w-[74%] truncate rounded-[14px] border border-[#26262A] bg-[#131315] px-3 py-2 text-start text-[12.5px] text-[#85858A] hover:border-[#34343B] hover:text-[#C9C9CE]"
          dir="auto"
        >
          {replyPreview ? previewMessageText(replyPreview) : t`Earlier message`}
        </button>
      ) : null}
    </>
  );
  if (isNarration) {
    return (
      <>
        {messageContext}
        <div className="flex justify-start">
          <div
            className="max-w-[74%] space-y-2.5 rounded-[20px] bg-[#1A1A1D] px-[18px] py-3 text-[15.5px] leading-[1.5] text-[#DFDFE2]"
            dir="auto"
          >
            {message.blocks.map((block, i) => {
              if (block.kind === "steps") {
                const isCurrentBlock = isLive && i === message.blocks.length - 1;
                return (
                  <ToolActivityDisclosure
                    key={i}
                    live={isLive}
                    label={isLive ? t`Working…` : toolActivityLabel(block.durationMs, false)}
                  >
                    <ToolSteps
                      steps={block.steps}
                      currentIndex={isCurrentBlock ? block.steps.length - 1 : undefined}
                    />
                  </ToolActivityDisclosure>
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
                aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                onClick={onSpeak}
                className="text-[12px] text-[#85858A] hover:text-[#ECECEE]"
              >
                {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
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
          const from = memberName?.(block.fromBotId) ?? t`bot`;
          const to = memberName?.(block.toBotId) ?? t`bot`;
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
        if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
          const sent = block.kind === "bot_message_sent";
          const peer = sent ? block.toBotName : block.fromBotName;
          const peerBotId = sent ? block.toBotId : block.fromBotId;
          const label = sent ? t`Messaged ${peer}` : t`Message from ${peer}`;
          return (
            <CollaborationMarker
              key={i}
              ariaLabel={label}
              color={peerBot(peerBotId)?.color ?? "#85858A"}
              identity={peerBotId}
              label={label}
              onClick={() => onOpenPeerMessages({ peerBotId, peerBotName: peer })}
            />
          );
        }
        if (block.kind === "channel_message") {
          return (
            <div
              key={i}
              className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-[#85858A]"
            >
              <span>
                {providerLabel(block.provider)} · {block.fromLabel}: {block.text}
              </span>
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
              <div
                className="max-w-[74%] rounded-[20px] bg-[#1A1A1D] px-[18px] py-3 text-[15.5px] leading-[1.5] text-[#DFDFE2]"
                dir="auto"
              >
                <ChatMarkdown streaming>{block.text}</ChatMarkdown>
              </div>
            </div>
          );
        }
        if (block.kind === "steps") {
          return (
            <div key={i} className="flex justify-start">
              <div
                className="max-w-[74%] space-y-1.5 rounded-[20px] bg-[#1A1A1D] px-[18px] py-3"
                dir="ltr"
              >
                <ToolActivityDisclosure
                  live={isLive}
                  label={isLive ? t`Working…` : toolActivityLabel(block.durationMs, false)}
                >
                  <ToolSteps
                    steps={block.steps}
                    currentIndex={isLive ? block.steps.length - 1 : undefined}
                  />
                </ToolActivityDisclosure>
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
                <span className="text-[15px] font-medium text-[#ECECEE]" dir="auto">
                  {block.name}
                </span>
                <span
                  className="rounded-full px-[11px] py-1 text-[13px]"
                  style={{
                    background: failed
                      ? "rgba(239,68,68,.14)"
                      : running
                        ? "rgba(245,160,60,.14)"
                        : "rgba(48,162,75,.14)",
                    color: failed ? "#EF4444" : running ? "#F5A03C" : "#4ECB71",
                    animation: running ? "rkPulse 1.2s ease-in-out infinite" : undefined,
                  }}
                >
                  {running ? <Trans>subagent</Trans> : block.status}
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
              className="w-[min(340px,90%)] rounded-[18px] border border-[#232326] bg-[#17171A] px-[18px] py-4 text-start disabled:opacity-60"
            >
              <div className="flex items-center justify-between">
                <span className="text-[15px] font-medium text-[#ECECEE]" dir="auto">
                  {block.name}
                </span>
                <span
                  className="rounded-full px-[11px] py-1 text-[13px]"
                  style={{
                    background: removed ? "rgba(239,68,68,.14)" : "rgba(48,162,75,.14)",
                    color: removed ? "#EF4444" : "#4ECB71",
                  }}
                >
                  {block.status === "archived" ? (
                    <Trans>archived</Trans>
                  ) : block.status === "deleted" ? (
                    <Trans>deleted</Trans>
                  ) : (
                    <Trans>bot</Trans>
                  )}
                </span>
              </div>
              <div className="mt-2 text-[14.5px] leading-[1.5] text-[#A8A8AD]" dir="auto">
                {removed
                  ? block.status === "archived"
                    ? t`Archived. Chat, memory, and files kept.`
                    : t`Removed with chat, computer, and memory.`
                  : block.title || t`Opened its thread.`}
              </div>
            </button>
          );
        }
        if (block.kind === "choice") {
          const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
          if (!botId) return null;
          return <ChoiceCard key={i} botId={botId} block={block} onBotChanged={onBotChanged} />;
        }
        if (block.kind === "app_connect") {
          const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
          if (!botId) return null;
          return (
            <div key={i} className="flex justify-start">
              <AppConnectCard botId={botId} block={block} />
            </div>
          );
        }
        if (block.kind === "chart") {
          return (
            <div key={i} className="flex justify-start">
              <ChartBlockView name={block.name} spec={block.spec} data={block.data} />
            </div>
          );
        }
        if (block.kind === "mcp_approval") {
          return (
            <div key={i} className="flex justify-start">
              <McpApprovalCard
                botId={"botId" in artifactTarget ? artifactTarget.botId : message.botId}
                name={block.name}
                serverId={block.serverId}
                transport={block.transport}
                endpoint={block.endpoint}
                needsOAuth={block.needsOAuth}
              />
            </div>
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
              <div
                className="max-w-[70%] whitespace-pre-wrap rounded-[20px] bg-[#F1F1EF] px-[18px] py-3 text-[15.5px] leading-[1.45] text-[#1A1A1A]"
                dir="auto"
              >
                {block.text}
              </div>
            </div>
          );
        }
        if (block.kind === "text") {
          return (
            <div key={i} className="flex justify-start">
              <div
                className="max-w-[74%] rounded-[20px] bg-[#1A1A1D] px-[18px] py-3 text-[15.5px] leading-[1.5] text-[#DFDFE2]"
                dir="auto"
              >
                <ChatMarkdown>{block.text}</ChatMarkdown>
                {voiceReady ? (
                  <button
                    type="button"
                    aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                    onClick={onSpeak}
                    className="mt-2 text-[12px] text-[#85858A] hover:text-[#ECECEE]"
                  >
                    {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
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
                <span className="text-[15px] font-medium text-[#ECECEE]">
                  <Trans>Computer</Trans>
                </span>
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

function ComputerModePicker({
  value,
  onChange,
}: {
  value: ComputerMode;
  onChange: (value: ComputerMode) => void;
}) {
  return (
    <div className="mt-4">
      <div className="text-[14px] text-[#85858A]">
        <Trans>Computer</Trans>
      </div>
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
            {mode === "team" ? <Trans>Team</Trans> : <Trans>Private</Trans>}
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
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!name.trim() || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({ name, title, description, computerMode });
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not create bot`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-[#85858A]">
          <Trans>New bot</Trans>
        </span>
        <button type="button" aria-label={t`Cancel new bot`} onClick={onCancel}>
          <X size={16} strokeWidth={1.8} />
        </button>
      </div>
      {error ? (
        <p role="alert" data-testid="create-bot-error" className="mb-3 text-[13px] text-[#EF4444]">
          {error}
        </p>
      ) : null}
      <label className="mt-6 block text-[14px] text-[#85858A]">
        <Trans>Name</Trans>
        <input
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChange={(e) => setName(e.target.value)}
          placeholder={t`Name this bot`}
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <label className="mt-4 block text-[14px] text-[#85858A]">
        <Trans>Title</Trans>
        <input
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t`Describe what this bot does`}
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <label className="mt-4 block text-[14px] text-[#85858A]">
        <Trans>Description</Trans>
        <textarea
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t`What this bot is for`}
          rows={4}
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <ComputerModePicker value={computerMode} onChange={setComputerMode} />
      <button
        type="button"
        disabled={!name.trim() || submitting}
        onClick={() => void handleSubmit()}
        className="mt-5 rounded-[11px] bg-[#F1F1EF] px-4 py-2 text-[#17171A] disabled:opacity-40"
      >
        {submitting ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
      </button>
    </div>
  );
}

function BotSettings({
  bot,
  computer,
  memoryProviderConfigured,
  onSave,
  onExport,
  onClear,
  onComputerChanged,
}: {
  bot: Bot;
  computer: ComputerStatus | null;
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
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: ThinkingLevel | null;
  }) => Promise<void>;
  onExport: () => Promise<void>;
  onClear: () => void;
  onComputerChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [description, setDescription] = useState(bot.description);
  const [computerMode, setComputerMode] = useState(bot.computerMode);
  const [memoryScope, setMemoryScope] = useState(bot.memoryScope);
  const [autoSpeak, setAutoSpeak] = useState(bot.autoSpeak);
  const [voiceId, setVoiceId] = useState(bot.voiceId ?? "");
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [modelKey, setModelKey] = useState(
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "",
  );
  const [thinkingLevel, setThinkingLevel] = useState(bot.thinkingLevel ?? "");
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [modelMetaReady, setModelMetaReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void rpc.voice
      .voices({})
      .then(setVoices)
      .catch(() => setVoices([]));
    void Promise.all([rpc.models.credentials(), rpc.models.list(), rpc.me()])
      .then(([nextCredentials, nextCatalog, nextMe]) => {
        setCredentials(nextCredentials);
        setCatalog(nextCatalog);
        setMe(nextMe);
        // Only mark ready on success — a failed catalog load must not clear
        // an existing thinkingLevel override on save.
        setModelMetaReady(true);
      })
      .catch(() => undefined);
  }, []);

  const connectedOptions: Array<{
    key: string;
    provider: string;
    modelId: string;
    label: string;
  }> = [];
  const seenOptions = new Set<string>();
  for (const credential of credentials) {
    const providerModels = catalog.filter(
      (entry) => entry.provider === credential.provider && !entry.placeholder,
    );
    const credentialInCatalog = Boolean(
      credential.modelId && providerModels.some((entry) => entry.id === credential.modelId),
    );
    // Catalog providers expand to every model for that connection. Free-form
    // credentials (model id not in the catalog) stay a single connected pair.
    const options =
      credential.modelId && !credentialInCatalog
        ? [
            {
              key: modelOptionKey(credential.provider, credential.modelId),
              provider: credential.provider,
              modelId: credential.modelId,
              label: `${credential.label} · ${credential.modelId}`,
            },
          ]
        : providerModels.map((entry) => ({
            key: modelOptionKey(entry.provider, entry.id),
            provider: entry.provider,
            modelId: entry.id,
            label: `${entry.providerName ?? entry.provider} · ${entry.label}`,
          }));
    for (const option of options) {
      if (seenOptions.has(option.key)) continue;
      seenOptions.add(option.key);
      connectedOptions.push(option);
    }
  }

  const effectiveProvider = modelKey
    ? parseModelOptionKey(modelKey)?.provider
    : (me?.defaultProvider ?? null);
  const effectiveModelId = modelKey
    ? parseModelOptionKey(modelKey)?.modelId
    : (me?.defaultModel ?? null);
  const effectiveEntry =
    effectiveProvider && effectiveModelId
      ? catalog.find(
          (entry) => entry.provider === effectiveProvider && entry.id === effectiveModelId,
        )
      : undefined;
  const thinkingOptions = (effectiveEntry?.thinkingLevels ?? []).filter((level) => level !== "off");

  return (
    <div data-testid="bot-settings">
      <div className="flex justify-center">
        <BotAvatar color={bot.color} identity={bot.id} size={64} status={bot.status} />
      </div>
      <label className="mt-6 block text-[14px] text-[#85858A]">
        <Trans>Name</Trans>
        <input
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChange={(e) => setName(e.target.value)}
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <label className="mt-4 block text-[14px] text-[#85858A]">
        <Trans>Title</Trans>
        <input
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <label className="mt-4 block text-[14px] text-[#85858A]">
        <Trans>Description</Trans>
        <textarea
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
        />
      </label>
      <details data-testid="bot-settings-advanced" className="group mt-5">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-[#85858A]">
          <span className="text-[#85858A]">
            <Trans>Advanced</Trans>
          </span>
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <ComputerModePicker value={computerMode} onChange={setComputerMode} />
        <Suspense fallback={null}>
          <ScratchpadSection botId={bot.id} />
        </Suspense>
        <label className="mt-4 block text-[14px] text-[#85858A]">
          <Trans>Model</Trans>
          <select
            value={modelKey}
            onChange={(event) => {
              setModelKey(event.target.value);
              setThinkingLevel("");
            }}
            className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
          >
            <option value="">
              {t`Space default`}
              {me?.defaultModel
                ? ` (${catalogLabel(catalog, me.defaultProvider, me.defaultModel) ?? me.defaultModel})`
                : ""}
            </option>
            {modelKey && !connectedOptions.some((option) => option.key === modelKey) ? (
              <option value={modelKey}>{parseModelOptionKey(modelKey)?.modelId ?? modelKey}</option>
            ) : null}
            {connectedOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {thinkingOptions.length ? (
          <label className="mt-4 block text-[14px] text-[#85858A]">
            <Trans>Thinking</Trans>
            <select
              value={thinkingLevel}
              onChange={(event) => setThinkingLevel(event.target.value)}
              className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
            >
              <option value="">{t`Default (medium)`}</option>
              {thinkingOptions.map((level) => (
                <option key={level} value={level}>
                  {thinkingLevelLabel(level)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {memoryProviderConfigured ? (
          <div className="mt-4 text-[14px] text-[#85858A]">
            <Trans>Memory scope</Trans>
            <div className="mt-2 flex gap-2">
              {(
                [
                  { value: null, label: t`Inherit default` },
                  { value: "isolated" as const, label: t`Isolated` },
                  { value: "shared" as const, label: t`Shared` },
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
          <Trans>Read replies aloud</Trans>
        </label>
        {voices.length ? (
          <label className="mt-4 block text-[14px] text-[#85858A]">
            <Trans>Voice</Trans>
            <select
              value={voiceId}
              onChange={(event) => setVoiceId(event.target.value)}
              className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
            >
              <option value="">{t`Account default`}</option>
              {voices.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </details>
      {error ? <p className="mt-2 text-[13px] text-[#EF4444]">{error}</p> : null}
      <div className="mt-5 flex flex-col items-start gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            setError(null);
            const selected = modelKey ? parseModelOptionKey(modelKey) : null;
            void onSave({
              name,
              title,
              description,
              instructions: description,
              computerMode,
              memoryScope,
              autoSpeak,
              voiceId: voiceId || null,
              modelProvider: selected?.provider ?? null,
              modelId: selected?.modelId ?? null,
              // Only clear thinking when catalog metadata is available; otherwise
              // preserve the stored override if models.list failed or is still loading.
              ...(modelMetaReady
                ? {
                    thinkingLevel: thinkingOptions.length
                      ? ((thinkingLevel || null) as ThinkingLevel | null)
                      : null,
                  }
                : {}),
            })
              .catch((err) => setError(err instanceof Error ? err.message : t`Could not save`))
              .finally(() => setSaving(false));
          }}
          className="rounded-[11px] bg-[#F1F1EF] px-4 py-2 text-[#17171A] disabled:opacity-40"
        >
          <Trans>Save</Trans>
        </button>
        <button
          type="button"
          onClick={() => void onExport()}
          className="text-[14px] text-[#85858A]"
        >
          <Trans>Export</Trans>
        </button>
        <button type="button" onClick={onClear} className="text-[14px] text-[#EF4444]">
          <Trans>Clear conversation</Trans>
        </button>
        <ComputerMaintenanceActions
          botId={bot.id}
          computer={computer}
          onChanged={onComputerChanged}
        />
      </div>
    </div>
  );
}

function modelOptionKey(provider: string, modelId: string) {
  return `${provider}::${modelId}`;
}

function thinkingLevelLabel(level: ThinkingLevel) {
  if (level === "xhigh") return t`Extra high`;
  if (level === "low") return t`Low`;
  if (level === "medium") return t`Medium`;
  if (level === "high") return t`High`;
  if (level === "minimal") return t`Minimal`;
  if (level === "max") return t`Max`;
  return `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;
}

function parseModelOptionKey(key: string) {
  const separator = key.indexOf("::");
  if (separator <= 0) return null;
  return { provider: key.slice(0, separator), modelId: key.slice(separator + 2) };
}

function catalogLabel(
  catalog: ModelCatalogEntry[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.label;
}

function NewSpaceDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: (name: string) => Promise<void>;
}) {
  const { t } = useLingui();
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

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    void onConfirm(trimmed).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : t`Could not create space`);
      setSaving(false);
    });
  };

  return (
    <div
      role="presentation"
      className="absolute inset-0 z-50 grid place-items-center bg-[rgba(4,4,5,.76)] px-5"
      onPointerDown={() => {
        if (!saving) onCancel();
      }}
    >
      <BuiCard
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-space-title"
        className="w-full max-w-[420px] border border-[#343438] p-5"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2.5">
          <Lock size={17} strokeWidth={1.8} className="text-[#A78BFA]" aria-hidden="true" />
          <h2 id="new-space-title" className="text-[17px] font-medium text-[#F1F1F2]">
            <Trans>New space</Trans>
          </h2>
        </div>
        <label className="mt-4 block text-[13.5px] text-[#C9C9CE]">
          <Trans>Name</Trans>
          <input
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") create();
              if (event.key === "Escape" && !saving) onCancel();
            }}
            placeholder={t`Customer support`}
            className="mt-2 w-full rounded-[11px] border border-[#343438] bg-[#101012] px-3.5 py-2.5 text-[14.5px] text-[#ECECEE] outline-none focus:border-[#66666D]"
          />
        </label>
        {error ? <p className="mt-3 text-[13.5px] text-[#EF4444]">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2.5">
          <BuiButton disabled={saving} onClick={onCancel}>
            <Trans>Cancel</Trans>
          </BuiButton>
          <BuiButton tone="accent" disabled={saving || !name.trim()} onClick={create}>
            {saving ? <Trans>Creating…</Trans> : <Trans>Create space</Trans>}
          </BuiButton>
        </div>
      </BuiCard>
    </div>
  );
}

function NewBotSectionDialog({
  bot,
  onCancel,
  onConfirm,
}: {
  bot: Pick<Bot, "name">;
  onCancel: () => void;
  onConfirm: (name: string) => Promise<void>;
}) {
  const { t } = useLingui();
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
            setError(err instanceof Error ? err.message : t`Could not create section`);
            setSaving(false);
          });
        }}
      >
        <h2 id="new-bot-section-title" className="text-[17px] font-medium text-[#F1F1F2]">
          <Trans>New section</Trans>
        </h2>
        <p className="mt-2 text-[14px] leading-6 text-[#9A9AA0]">
          <Trans>Create a section and move {bot.name} into it.</Trans>
        </p>
        <label className="mt-4 block text-[13.5px] text-[#C9C9CE]">
          <Trans>Name</Trans>
          <input
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-2 w-full rounded-[11px] border border-[#343438] bg-[#101012] px-3.5 py-2.5 text-[14.5px] text-[#ECECEE] outline-none focus:border-[#66666D]"
          />
        </label>
        {error ? <p className="mt-3 text-[13.5px] text-[#EF4444]">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            disabled={saving}
            onClick={onCancel}
            className="rounded-[10px] px-3.5 py-2 text-[14px] text-[#C9C9CE] hover:bg-[#29292D] disabled:opacity-40"
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="rounded-[10px] bg-[#F1F1EF] px-3.5 py-2 text-[14px] font-medium text-[#17171A] disabled:opacity-40"
          >
            {saving ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
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
  bot: Pick<Bot, "name">;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useLingui();
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
          <Trans>Clear {bot.name}’s conversation?</Trans>
        </h2>
        <p
          id="clear-conversation-description"
          className="mt-2 text-[14px] leading-6 text-[#9A9AA0]"
        >
          <Trans>
            This permanently removes every message and stops current work. The chat remains
            available.
          </Trans>
        </p>
        {error ? <p className="mt-3 text-[13.5px] text-[#EF4444]">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            disabled={clearing}
            onClick={onCancel}
            className="rounded-[10px] px-3.5 py-2 text-[14px] text-[#C9C9CE] hover:bg-[#29292D] disabled:opacity-40"
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            disabled={clearing}
            onClick={() => {
              setClearing(true);
              setError(null);
              void onConfirm().catch((err: unknown) => {
                setError(err instanceof Error ? err.message : t`Could not clear conversation`);
                setClearing(false);
              });
            }}
            className="rounded-[10px] bg-[#DC2626] px-3.5 py-2 text-[14px] font-medium text-white disabled:opacity-40"
          >
            {clearing ? <Trans>Clearing…</Trans> : <Trans>Clear</Trans>}
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
  const { t } = useLingui();
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
          <Trans>Delete {bot.name}?</Trans>
        </h2>
        <p id="delete-bot-description" className="mt-2 text-[14px] leading-6 text-[#9A9AA0]">
          <Trans>
            Its conversation, files, and routines will be permanently deleted. Bots it created stay
            in your list.
          </Trans>
        </p>
        <fieldset className="mt-4 space-y-2">
          <legend className="mb-2 text-[13.5px] text-[#C9C9CE]">
            <Trans>What about its memories?</Trans>
          </legend>
          <label className="flex cursor-pointer gap-3 rounded-[11px] border border-[#343438] p-3">
            <input
              type="radio"
              name="delete-memory"
              checked={!deleteMemories}
              onChange={() => setDeleteMemories(false)}
            />
            <span>
              <span className="block text-[14px] text-[#ECECEE]">
                <Trans>Keep memories</Trans>
              </span>
              <span className="mt-0.5 block text-[12.5px] text-[#85858A]">
                <Trans>Move them to your shared memory.</Trans>
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
              <span className="block text-[14px] text-[#ECECEE]">
                <Trans>Delete memories too</Trans>
              </span>
              <span className="mt-0.5 block text-[12.5px] text-[#85858A]">
                <Trans>This cannot be undone.</Trans>
              </span>
            </span>
          </label>
        </fieldset>
        {error ? <p className="mt-3 text-[13.5px] text-[#EF4444]">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            disabled={deleting}
            onClick={onCancel}
            className="rounded-[10px] px-3.5 py-2 text-[14px] text-[#C9C9CE] hover:bg-[#29292D] disabled:opacity-40"
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={() => {
              setDeleting(true);
              setError(null);
              void onConfirm(deleteMemories).catch((err: unknown) => {
                setError(err instanceof Error ? err.message : t`Could not delete bot`);
                setDeleting(false);
              });
            }}
            className="rounded-[10px] bg-[#DC2626] px-3.5 py-2 text-[14px] font-medium text-white disabled:opacity-40"
          >
            {deleting ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteItemDialog({
  item,
  noun,
  onCancel,
  onConfirm,
}: {
  item: { name: string };
  noun: "group" | "routine";
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useLingui();
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
        aria-labelledby="delete-item-title"
        aria-describedby="delete-item-description"
        className="w-full max-w-[420px] rounded-[18px] border border-[#343438] bg-[#1A1A1D] p-5 shadow-[0_24px_70px_rgba(0,0,0,.65)]"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h2 id="delete-item-title" className="text-[17px] font-medium text-[#F1F1F2]">
          <Trans>Delete {item.name}?</Trans>
        </h2>
        <p id="delete-item-description" className="mt-2 text-[14px] leading-6 text-[#9A9AA0]">
          <Trans>This cannot be undone.</Trans>
        </p>
        {error ? <p className="mt-3 text-[13.5px] text-[#EF4444]">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            disabled={deleting}
            onClick={onCancel}
            className="rounded-[10px] px-3.5 py-2 text-[14px] text-[#C9C9CE] hover:bg-[#29292D] disabled:opacity-40"
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={() => {
              setDeleting(true);
              setError(null);
              void onConfirm().catch((err: unknown) => {
                setError(
                  err instanceof Error
                    ? err.message
                    : noun === "group"
                      ? t`Could not delete group`
                      : t`Could not delete routine`,
                );
                setDeleting(false);
              });
            }}
            className="rounded-[10px] bg-[#DC2626] px-3.5 py-2 text-[14px] font-medium text-white disabled:opacity-40"
          >
            {deleting ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
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
  if (state === "booting" || booting) return t`Booting live desktop…`;
  if (state === "running") return label;
  if (state === "suspended") return t`Computer is asleep. Take control to wake it.`;
  if (state === "error") return t`Computer failed to boot`;
  return t`Computer is stopped`;
}

function computerLabel(mode: ComputerStatus["mode"] | undefined, botName: string) {
  return mode === "dedicated" ? t`${botName}’s computer` : t`Team Computer`;
}

function ChoiceCard({
  botId,
  block,
  onBotChanged,
}: {
  botId: string;
  block: Extract<MessageBlock, { kind: "choice" }>;
  onBotChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(optionId: string) {
    setPending(true);
    setError(null);
    try {
      await rpc.onboarding.choose({ botId, optionId });
      await onBotChanged().catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save this choice`);
      setPending(false);
    }
  }

  return (
    <div className="flex justify-start">
      <div className="w-[min(420px,80%)] rounded-[20px] bg-[#1A1A1D] px-[18px] py-[14px]">
        <div className="text-[15.5px] text-[#DFDFE2]">{block.question}</div>
        {block.subtitle ? (
          <div className="mt-0.5 text-[13px] text-[#85858A]">{block.subtitle}</div>
        ) : null}
        <div className="mt-3 space-y-1.5">
          {block.options
            .filter((option) => !block.answerId || option.id === block.answerId)
            .map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={Boolean(block.answerId) || pending}
                onClick={() => void choose(option.id)}
                className={`flex w-full items-center gap-3 rounded-[12px] border border-[#2A2A2F] px-3.5 py-3 text-start disabled:opacity-60 ${block.answerId ? "bg-[#1F1F23]" : "bg-[#161619] hover:bg-[#222226]"}`}
              >
                <span className="grid h-[24px] w-[24px] place-items-center rounded-[7px] bg-[#232327] text-[12.5px] text-[#9A9AA0]">
                  {option.letter}
                </span>
                <span
                  className={`flex-1 text-[15px] ${block.answerId ? "text-[#85858A]" : "text-[#ECECEE]"}`}
                >
                  {option.label}
                </span>
                {block.answerId === option.id ? <span className="text-[#B9B9C0]">✓</span> : null}
              </button>
            ))}
        </div>
        {error ? <p className="mt-2 text-xs text-[#F07178]">{error}</p> : null}
      </div>
    </div>
  );
}

function AppConnectCard({
  botId,
  block,
}: {
  botId: string;
  block: Extract<MessageBlock, { kind: "app_connect" }>;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [localStatus, setLocalStatus] = useState<"pending" | "connected">(block.status);
  const [error, setError] = useState<string | null>(null);
  const connectionAttempt = useRef<AbortController | null>(null);
  const status = block.status === "connected" ? "connected" : localStatus;
  useEffect(() => () => connectionAttempt.current?.abort(), []);

  async function authorize() {
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    setBusy(true);
    setError(null);
    try {
      const started = await rpc.connections.begin({
        provider: block.provider,
        displayName: block.name,
      });
      if (started.authorizationUrl) {
        window.open(started.authorizationUrl, "rakazo-app-connect", "popup,width=560,height=720");
      }
      for (let i = 0; i < 60; i += 1) {
        if (controller.signal.aborted) return;
        const row = await rpc.connections
          .complete({ connectionId: started.connectionId })
          .catch(() => undefined);
        if (row?.status === "connected") {
          if (controller.signal.aborted) return;
          setLocalStatus("connected");
          await rpc.onboarding
            .appConnected({ botId, provider: block.provider })
            .catch(() => undefined);
          return;
        }
        await abortableDelay(2_000, controller.signal);
      }
      if (!controller.signal.aborted) setError(t`Authorization timed out. Please try again.`);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : t`Could not authorize this app`);
      }
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <BuiCard
      role="group"
      aria-label={t`${block.name} connection`}
      className="w-[min(420px,80%)] px-4 py-3.5"
    >
      <div className="flex items-center gap-3.5">
        {block.logo ? (
          <img
            src={block.logo}
            alt=""
            className="h-10 w-10 rounded-[10px] bg-white object-contain p-1"
          />
        ) : (
          <span className="grid h-10 w-10 place-items-center rounded-[10px] bg-[#30356A] text-[15px] text-[#E2E4FF]">
            {block.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium" style={{ color: "var(--bui-ink)" }}>
            {block.name}
          </span>
          <span className="block truncate text-[13px]" style={{ color: "var(--bui-ink-3)" }}>
            {block.description}
          </span>
        </span>
        {status === "connected" ? (
          <SuccessPop label={t`Connected`} />
        ) : (
          <BuiButton disabled={busy} onClick={() => void authorize()}>
            {busy ? t`Waiting…` : t`Authorize`}
          </BuiButton>
        )}
      </div>
      {error ? <p className="mt-2 text-xs text-[#F07178]">{error}</p> : null}
    </BuiCard>
  );
}

function ChartCanvas({
  spec,
  data,
  width,
  height,
}: {
  spec: Record<string, unknown>;
  data: unknown[];
  width: number;
  height?: number;
}) {
  const { t } = useLingui();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    title?: string;
    swatches: { label: string; color: string }[];
  }>({ swatches: [] });
  useEffect(() => {
    let cancelled = false;
    // Plot loads lazily so threads without charts never pay for the library.
    void (async () => {
      try {
        const { buildPlotParts } = await import("@rakazo/core/plot");
        if (cancelled || !ref.current) return;
        // Hover inspection by default: give the first mark a tooltip unless
        // the spec already asks for one somewhere.
        const marks = Array.isArray((spec as { marks?: unknown[] }).marks)
          ? ((spec as { marks: { options?: Record<string, unknown> }[] }).marks ?? [])
          : [];
        const hasTip = marks.some((mark) => mark.options && "tip" in mark.options);
        const liveSpec = hasTip
          ? spec
          : {
              ...spec,
              marks: marks.map((mark, index) =>
                index === 0 ? { ...mark, options: { ...(mark.options ?? {}), tip: true } } : mark,
              ),
            };
        const parts = buildPlotParts(liveSpec as never, data, document, { width, height });
        setMeta({ title: parts.title, swatches: parts.swatches });
        setError(null);
        ref.current.replaceChildren(parts.plotted);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t`Could not render chart`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spec, data, width, height, t]);
  if (error)
    return (
      <div className="text-[13px] text-[#F3A2AA]">
        <Trans>Chart failed to render: {error}</Trans>
      </div>
    );
  return (
    <div className="text-[#C9C9CE]">
      {meta.title ? (
        <div className="mb-1 text-[14.5px] font-semibold text-[#ECECEE]">{meta.title}</div>
      ) : null}
      {meta.swatches.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1">
          {meta.swatches.map((swatch) => (
            <span
              key={swatch.label}
              className="flex items-center gap-1.5 text-[12px] text-[#A6A6AD]"
            >
              <span
                className="h-[10px] w-[10px] rounded-[3px]"
                style={{ background: swatch.color }}
              />
              {swatch.label}
            </span>
          ))}
        </div>
      ) : null}
      <div ref={ref} className="[&_svg]:max-w-full" />
    </div>
  );
}

type McpApprovalState = "pending" | "connecting" | "connected" | "dismissed";

/** Approval card for an agent-created MCP server: the user completes browser
 * OAuth (or confirms no authorization is needed) without leaving the chat. */
function McpApprovalCard({
  botId,
  name,
  serverId,
  transport,
  endpoint,
  needsOAuth,
}: {
  botId: string | undefined;
  name: string;
  serverId: string;
  transport: string;
  endpoint: string | null;
  needsOAuth: boolean;
}) {
  const { t } = useLingui();
  const [state, setState] = useState<McpApprovalState>("pending");
  const [error, setError] = useState<string | null>(null);

  async function authorize() {
    if (!botId) {
      setError(t`This server cannot be assigned without a bot.`);
      return;
    }
    setState("connecting");
    setError(null);
    try {
      if (needsOAuth) {
        const result = await connectMcpOauth(serverId);
        if (result === "cancelled") {
          setState("pending");
          return;
        }
      }
      await rpc.mcp.assignments.approve({ botId, serverId });
      setState("connected");
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not approve this server`);
      setState("pending");
    }
  }

  const summary = endpoint ?? `stdio · ${transport}`;
  return (
    <BuiCard className="max-w-[74%] p-4">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#30356A] text-xs text-[#E2E4FF]">
          M
        </span>
        <span className="text-[14.5px] font-medium" style={{ color: "var(--bui-ink)" }}>
          <Trans>Connect MCP server “{name}”</Trans>
        </span>
      </div>
      <p className="mt-1.5 truncate text-[12px]" style={{ color: "var(--bui-ink-3)" }}>
        {summary}
      </p>
      {state === "pending" || state === "connecting" ? (
        <>
          <p className="mt-2 text-[13px] leading-[1.5]" style={{ color: "var(--bui-ink-2)" }}>
            {needsOAuth
              ? t`This server uses browser sign-in. Authorize it to let your agents use its tools — a popup will open.`
              : t`Approve this server to let your agent use its tools.`}
          </p>
          {error ? <p className="mt-2 text-xs text-[#F07178]">{error}</p> : null}
          <div className="mt-3 flex gap-2">
            <BuiButton
              tone="accent"
              disabled={state === "connecting"}
              onClick={() => void authorize()}
            >
              {state === "connecting" ? t`Connecting…` : needsOAuth ? t`Authorize` : t`Approve`}
            </BuiButton>
            <BuiButton onClick={() => setState("dismissed")}>
              <Trans>Not now</Trans>
            </BuiButton>
          </div>
        </>
      ) : null}
      {state === "connected" ? (
        <div className="mt-3">
          <SuccessPop label={t`Connected — its tools are available from your next message.`} />
        </div>
      ) : null}
      {state === "dismissed" ? (
        <p className="mt-2 text-[13px] text-[#85858A]">
          <Trans>Dismissed — reconnect anytime from MCP settings.</Trans>
        </p>
      ) : null}
    </BuiCard>
  );
}

function ChartBlockView({
  name,
  spec,
  data,
}: {
  name: string;
  spec: Record<string, unknown>;
  data: unknown[];
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    if (!expanded) return;
    setViewport({ width: window.innerWidth, height: window.innerHeight });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [expanded]);
  const expandedViewport = chartViewport(viewport.width, viewport.height);
  return (
    <>
      <div className="group relative max-w-[74%] rounded-[20px] bg-[#17171A] p-4">
        <ChartCanvas spec={spec} data={data} width={520} />
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="absolute end-3 top-3 rounded-lg border border-[#34343B] bg-[#1F1F22] px-2.5 py-1 text-[11px] text-[#B9B9C0] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A6A6AD]"
        >
          <Trans>Expand</Trans>
        </button>
      </div>
      {expanded ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(4,4,5,.78)] p-8"
          role="dialog"
          aria-modal="true"
          aria-label={name}
          onClick={(event) => {
            if (event.target === event.currentTarget) setExpanded(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setExpanded(false);
          }}
        >
          <div className="max-h-[92vh] w-[min(1320px,94vw)] overflow-auto rounded-[24px] border border-[#2A2A31] bg-[#141416] p-8 shadow-[0_40px_90px_rgba(0,0,0,.6)]">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[13px] text-[#85858A]">{name}</span>
              <button
                type="button"
                aria-label={t`Close chart`}
                onClick={() => setExpanded(false)}
                className="text-lg text-[#85858A] hover:text-[#DFDFE2]"
              >
                ✕
              </button>
            </div>
            <ChartCanvas
              spec={spec}
              data={data}
              width={expandedViewport.width}
              height={expandedViewport.height}
            />
          </div>
        </div>
      ) : null}
    </>
  );
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
  const { t } = useLingui();
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
          aria-label={t`Close image preview`}
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

function newClientNonce(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
