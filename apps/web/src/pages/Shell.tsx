import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentSkillCatalogEntry,
  Bot,
  BotSection,
  ComputerMode,
  ComputerReleaseReason,
  ComputerStatus,
  Group,
  Me,
  MessageReaction,
  ProductEvent,
  Routine,
  SearchHit,
  Space,
  SpaceMemoryConfig,
  TaughtSkill,
  ThreadMessage,
  ThreadSnapshot,
  VoiceStatus,
} from "@rakazo/contracts";
import {
  ATTACHMENT_MAX_COUNT,
  attachmentMaxBytes,
  attachmentSizeLabel,
  normalizeCreateBotProfile,
} from "@rakazo/contracts";
import type { ComposerMention } from "@rakazo/core";
import {
  accountDisplay,
  answerableAskMessageIds,
  anySignal,
  attachmentsForThread,
  buildComposerMentionOptions,
  dismissableAskMessageIds,
  foldPeerReplies,
  inferAttachmentMimeType,
  isActive,
  isRetryableError,
  isRunTerminalEvent,
  isRunWorking,
  reorderBotTo,
  resolveComposerSendPlan,
  runThreadSubscription,
  searchHitThreadTarget,
  speechFromBlocks,
  withLiveStreamingProgress,
} from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import {
  AvatarStyleProvider,
  BotAvatar,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  GroupAvatar,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  Sidebar,
  Spinner,
  toast,
} from "@rakazo/ui-web";
import { useIsMobile } from "@rakazo/ui-web/hooks/use-mobile";
import {
  Menu,
  Monitor,
  Pencil,
  Phone,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import type { MutableRefObject } from "react";
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ComputerMaintenanceActions } from "../components/ComputerMaintenanceActions";
import { computersAreUnavailable } from "../components/ComputersUnavailableHint";
import { ComputerUpdateProgress } from "../components/ComputerUpdateProgress";
import { CallCard, CallReturnBar } from "../components/call/CallCard";
import { IncomingCall } from "../components/call/IncomingCall";
import { lazyOverlay } from "../components/ErrorBoundary";
import { IconTooltip } from "../components/IconTooltip";
import { PasskeyOffer } from "../components/PasskeyOffer";
import { SidebarFooter } from "../components/SidebarFooter";
import type { ActivityListFilters } from "../lib/activity-list-filters";
import { emptyActivityFilters } from "../lib/activity-list-filters";
import { readActivityMode, writeActivityMode } from "../lib/activity-mode";
import type { ArtifactTarget } from "../lib/artifact-open";
import { authClient } from "../lib/auth";
import {
  discardPrimedBootstrap,
  primeSpaceBootstrap,
  takeInitialBootstrap,
} from "../lib/bootstrap";
import { initialBootstrapTarget } from "../lib/bootstrap-target";
import type { BotsSidebarDensity } from "../lib/bots-sidebar-density-pref";
import {
  getBotsSidebarDensity,
  subscribeBotsSidebarDensity,
} from "../lib/bots-sidebar-density-pref";
import { readBotsSidebarCollapsed, writeBotsSidebarCollapsed } from "../lib/bots-sidebar-pref";
import {
  deliverBrowserNotification as deliverNativeBrowserNotification,
  requestBrowserNotificationPermission,
  shouldNotifyBrowser,
} from "../lib/browser-notifications";
import {
  getSnapshot as getCallSnapshot,
  setCallMinimized,
  startCall,
  useCallSession,
} from "../lib/call-session";
import { newClientId } from "../lib/client-id";
import { setComposerUnsavedWork } from "../lib/composer-draft";
import {
  getComposerEnterToSend,
  subscribeComposerEnterToSend,
} from "../lib/composer-enter-to-send-pref";
import {
  bootComputerOnce,
  embeddableScreenUrl,
  isProxiedScreenUrl,
  loadComputerScreen,
  probeScreen,
  SCREEN_FRAME_LOAD_TIMEOUT_MS,
  screenFrameError,
  screenFrameMessage,
  screenFrameStarted,
} from "../lib/computer-screen";
import { connectedAppMarks } from "../lib/connected-apps";
import { scheduleFocusPrompt } from "../lib/focus-prompt";
import { localTimezone } from "../lib/local-timezone";
import {
  readFileAsBase64,
  revokePendingAttachmentPreviews,
  usePendingAttachmentPreviewCleanup,
} from "../lib/pending-attachments";
import { markAfterPaint, markOnce } from "../lib/performance";
import { usePreloadRecoveryState } from "../lib/preload-recovery";
import { getResponseStreamingEnabled, subscribeResponseStreaming } from "../lib/response-streaming";
import type { Panel, RightPanelState } from "../lib/right-panel-state";
import {
  readRightPanelState,
  rightPanelStorageKey,
  writeRightPanelState,
} from "../lib/right-panel-state";
import { clearSpaceSelection, createSpaceRpc, selectedSpaceId, selectSpace } from "../lib/rpc";
import { readSeenRunErrorIds, rememberSeenRunErrorId } from "../lib/run-error-storage";
import { useSignOut } from "../lib/sign-out";
import {
  guardShellNavigate,
  markShellReady,
  remountShellForSpace,
  spaceSwitchDecision,
  useSpaceEpoch,
} from "../lib/space-switch";
import {
  activeThreadRuns,
  applyThreadSendReceipt,
  clearActiveThreadRuns,
  computerPanelNeedsMaintenance,
  computerPanelNeedsScreen,
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
import { getToolActivityEnabled, subscribeToolActivity } from "../lib/tool-activity-preference";
import { transcriptCanSnapAfterFrame, transcriptIsNearEnd } from "../lib/transcript-scroll";
import { speaker } from "../lib/tts";
import { useDesktopBadge } from "../lib/use-desktop-badge";
import { errorText } from "../lib/user-error";
import { ActivityList } from "./ActivityList";
import { CreateGroupForm, GroupSettings, memberName } from "./GroupPanel";
import { HostComputerPrompt } from "./HostComputerPrompt";
import { ResizableSidePanel } from "./ResizableSidePanel";
import { RoutineEditor } from "./RoutineEditor";
import type { SettingsSection } from "./SettingsOverlay";
import { SpaceSearchResults } from "./SpaceSearch";
import { ArchivedChats } from "./shell/archived-chats";
import { BotSettings, CreateBotForm } from "./shell/bot-panel";
import type { PendingAttachment } from "./shell/chat-shared";
import { FALLBACK_BOT_COLOR } from "./shell/chat-shared";
import { CommandPalette, isCommandPaletteHotkey } from "./shell/command-palette";
import { Composer } from "./shell/composer";
import { ComputerOverlay } from "./shell/computer-overlay";
import { ComputerPanel } from "./shell/computer-panel";
import {
  ClearConversationDialog,
  DeleteBotDialog,
  DeleteItemDialog,
  NewBotSectionDialog,
  NewSpaceDialog,
  PickerInfoDialog,
  RenameBotSectionDialog,
  RenameSpaceDialog,
} from "./shell/dialogs";
import type { RosterDropTarget } from "./shell/roster-drop";
import { resolveRosterDrop } from "./shell/roster-drop";
import { SidebarHeader } from "./shell/sidebar-header";
import { BotsSidebarLayout } from "./shell/sidebar-layout";
import { SidebarRoster } from "./shell/sidebar-roster";
import { commitSpaceRename, countUnreadChats, sidebarGroupsForSpaces } from "./shell/space-sidebar";
import { Transcript } from "./shell/transcript";
import { useRoutineEditor } from "./shell/use-routine-editor";
import { useSidebarExpansion } from "./shell/use-sidebar-expansion";

const READ_ALOUD_TOAST = "read-aloud-error";

/** Chat read-aloud has no caption to carry a failure, so it surfaces as a toast. */
function readAloud(text: string, opts: { botId: string; messageId: string }) {
  void speaker.speak(text, opts).then((error) => {
    if (error) toast.error(error, { id: READ_ALOUD_TOAST });
  });
}

const BotContextMenu = lazyOverlay(() =>
  import("./BotContextMenu").then((module) => module.BotContextMenu),
);
const MessagingSettingsOverlay = lazyOverlay(() =>
  import("./MessagingSettingsOverlay").then((module) => module.MessagingSettingsOverlay),
);
const SettingsOverlay = lazyOverlay(() =>
  import("./SettingsOverlay").then((module) => module.SettingsOverlay),
);
const PeerMessagesOverlay = lazyOverlay(() =>
  import("./PeerMessagesOverlay").then((module) => module.PeerMessagesOverlay),
);
const PluginsOverlay = lazyOverlay(() =>
  import("./PluginsOverlay").then((module) => module.PluginsOverlay),
);
const McpServersOverlay = lazyOverlay(() =>
  import("./McpServersOverlay").then((module) => module.McpServersOverlay),
);

type PendingBrowserNotification = {
  event: Pick<ProductEvent, "id" | "type" | "threadId" | "botId" | "payload">;
  botId: string;
  botName: string;
  groupNotification: boolean;
};

const THREAD_SNAPSHOT_TIMEOUT_MS = 2_000;
/** Bound Settings leave so a hung voice status refresh cannot block dismissal. */
const VOICE_STATUS_REFRESH_TIMEOUT_MS = 10_000;
const MOBILE_SIDEBAR_SWIPE_EDGE_PX = 32;
const MOBILE_SIDEBAR_SWIPE_DISTANCE_PX = 56;
function threadSnapshotSignal(parent: AbortSignal): AbortSignal {
  return anySignal([parent, AbortSignal.timeout(THREAD_SNAPSHOT_TIMEOUT_MS)]);
}

function voiceStatusRefreshTimeout(): Promise<never> {
  return new Promise((_, reject) => {
    AbortSignal.timeout(VOICE_STATUS_REFRESH_TIMEOUT_MS).addEventListener("abort", () => {
      reject(new DOMException("Voice status refresh timed out", "TimeoutError"));
    });
  });
}

export function ShellPage() {
  // A new key per space switch, so nothing from the previous space survives it.
  const spaceEpoch = useSpaceEpoch();
  return <SpaceShell key={spaceEpoch} />;
}

function SpaceShell() {
  const { t } = useLingui();
  const { botId, groupId } = useParams();
  const [rpc] = useState(() => createSpaceRpc(selectedSpaceId()));
  const routerNavigate = useNavigate();
  const navigateRef = useRef(routerNavigate);
  navigateRef.current = routerNavigate;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const navigate = useMemo(
    () =>
      guardShellNavigate(
        () => navigateRef.current,
        () => alive.current,
      ),
    [],
  );
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
  const {
    collapsedSidebarSections,
    collapsedRosterParents,
    toggleSidebarSection,
    toggleRosterParent,
  } = useSidebarExpansion(userId);
  useEffect(() => {
    setBotsSidebarCollapsed(readBotsSidebarCollapsed(userId));
  }, [userId]);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const snapshotRef = useRef<ThreadSnapshot | null>(null);
  const streamResponses = useSyncExternalStore(
    subscribeResponseStreaming,
    getResponseStreamingEnabled,
    () => false,
  );
  const streamResponsesRef = useRef(streamResponses);
  streamResponsesRef.current = streamResponses;
  const showToolActivity = useSyncExternalStore(
    subscribeToolActivity,
    getToolActivityEnabled,
    () => true,
  );
  const botsSidebarDensity = useSyncExternalStore<BotsSidebarDensity>(
    subscribeBotsSidebarDensity,
    getBotsSidebarDensity,
    () => "comfortable",
  );
  const enterToSend = useSyncExternalStore(
    subscribeComposerEnterToSend,
    getComposerEnterToSend,
    () => false,
  );
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  usePendingAttachmentPreviewCleanup(pendingAttachments);
  const [replyTarget, setReplyTarget] = useState<ThreadMessage | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    setComposerUnsavedWork(sending || pendingAttachments.length > 0);
    return () => setComposerUnsavedWork(false);
  }, [sending, pendingAttachments.length]);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [logOutError, setLogOutError] = useState<string | null>(null);
  const { signingOut, logOut } = useSignOut(() => {
    clearSpaceSelection();
    navigate("/");
  }, setLogOutError);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [panel, setPanelState] = useState<Panel>(null);
  const [restoredPanelKey, setRestoredPanelKey] = useState<string | null>(null);
  const panelStorageKeyRef = useRef<string | null>(null);
  const observedPanelKey = useRef<string | null>(null);
  const explicitPanelTarget = useRef<string | null>(null);
  const pendingPanelRestore = useRef<RightPanelState | null>(null);
  const pendingExplicitPanel = useRef(false);
  const panelSearch = useRef({ searchParams, setSearchParams });
  panelSearch.current = { searchParams, setSearchParams };
  const setPanel = useCallback((next: Panel | ((current: Panel) => Panel)) => {
    // A user navigation wins over a saved routine still waiting for its list.
    pendingPanelRestore.current = null;
    pendingExplicitPanel.current = panelStorageKeyRef.current === null;
    setRestoredPanelKey(panelStorageKeyRef.current);
    setPanelState(next);
    const currentSearch = panelSearch.current;
    if (currentSearch.searchParams.has("routine")) {
      const params = new URLSearchParams(currentSearch.searchParams);
      params.delete("routine");
      currentSearch.setSearchParams(params, { replace: true });
    }
  }, []);
  const [peerConversation, setPeerConversation] = usePreloadRecoveryState<{
    peerBotId: string;
    peerBotName: string;
  } | null>("peerConversation", null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routinesBotId, setRoutinesBotId] = useState<string | null>(null);
  const [taughtSkills, setTaughtSkills] = useState<TaughtSkill[]>([]);
  const [taughtSkillsBotId, setTaughtSkillsBotId] = useState<string | null>(null);
  const [agentSkills, setAgentSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [mentionRoutines, setMentionRoutines] = useState<Array<Routine & { botName?: string }>>([]);
  const [footerLogos, setFooterLogos] = useState<Array<{ name: string; logo: string | null }>>([]);
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
  // A very fast run can finish over SSE while its threads.send response is still
  // returning. Do not let that late receipt resurrect terminal work as queued.
  const terminalRunReceipts = useRef(new Set<string>());
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
    setSnapshot(withLiveStreamingProgress(next, streamResponsesRef.current));
  }

  useEffect(() => {
    setSnapshot(withLiveStreamingProgress(snapshotRef.current, streamResponses));
  }, [streamResponses]);

  function commitComputer(next: ComputerStatus | null) {
    computerRef.current = next;
    setComputer(next);
  }

  function updateSnapshot(update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) {
    commitSnapshot(update(snapshotRef.current));
  }
  const [pluginsOpen, setPluginsOpen] = usePreloadRecoveryState("integrations", false);
  const [mcpOpen, setMcpOpen] = usePreloadRecoveryState("mcp", false);
  const [settingsOpen, setSettingsOpen] = usePreloadRecoveryState("settings", false);
  const [settingsSection, setSettingsSection] = usePreloadRecoveryState<SettingsSection>(
    "settingsSection",
    "general",
  );
  const [messagingSettingsOpen, setMessagingSettingsOpen] = usePreloadRecoveryState(
    "messaging",
    false,
  );
  const [messagingSurfaceEnabled, setMessagingSurfaceEnabled] = useState(false);
  const [messagingProviders, setMessagingProviders] = useState<string[]>([]);
  const [memoryProviderConfig, setMemoryProviderConfig] = useState<
    SpaceMemoryConfig | null | undefined
  >(undefined);
  const memoryProviderConfigRevision = useRef(0);
  const call = useCallSession();
  /** Calls a bot, or opens voice settings first when no voice is connected. */
  const callBot = (bot: Bot) => {
    if (!bootstrapMe?.phoneCallsEnabled) return;
    if (!voiceStatus?.ready) {
      openSettings("voice");
      return;
    }
    startCall({
      botId: bot.id,
      botName: bot.name,
      botColor: bot.color,
      transcribe: voiceStatus ? Boolean(voiceStatus.transcribe) : undefined,
    });
  };
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [dismissedRunErrorIds, setDismissedRunErrorIds] =
    useState<ReadonlySet<string>>(readSeenRunErrorIds);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const mobileSidebarSwipeRef = useRef<{ startX: number; startY: number } | null>(null);
  const [draggedBotId, setDraggedBotId] = useState<string | null>(null);
  const [rosterDropKey, setRosterDropKey] = useState<string | null>(null);
  const [botsSidebarCollapsed, setBotsSidebarCollapsed] = useState(false);
  const focusPromptAbortRef = useRef<AbortController | null>(null);
  const focusPromptBotIdRef = useRef<string | null>(null);
  const isMobileSidebar = useIsMobile();
  const miniSidebar = botsSidebarCollapsed && !isMobileSidebar;
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [pickerInfoTopic, setPickerInfoTopic] = useState<"group" | "space" | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

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
  const [activityFilters, setActivityFilters] = useState<ActivityListFilters>(emptyActivityFilters);
  const [activityFiltersExpanded, setActivityFiltersExpanded] = useState(false);
  const activityFiltersId = useId();
  const activityFilterCount =
    Number(activityFilters.status !== "all") +
    Number(Boolean(activityFilters.dateRange.from)) +
    Number(Boolean(activityFilters.dateRange.to));
  const toggleActivityMode = useCallback(() => {
    setQuery("");
    setActivityFilters(emptyActivityFilters());
    setActivityFiltersExpanded(false);
    setActivityMode((on) => {
      const next = !on;
      writeActivityMode(next);
      return next;
    });
  }, []);
  const [botMenu, setBotMenu] = useState<{ kind: "bot" | "group"; id: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<Group | null>(null);
  const [deleteSpaceTarget, setDeleteSpaceTarget] = useState<Space | null>(null);
  const [renameSpaceTarget, setRenameSpaceTarget] = useState<Space | null>(null);
  const [spaceMenu, setSpaceMenu] = useState<{
    id: string;
    position: { x: number; y: number };
  } | null>(null);
  const spaceMenuAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (spaceMenu || !spaceMenuAnchor.current) return;
    spaceMenuAnchor.current.focus();
    spaceMenuAnchor.current = null;
  }, [spaceMenu]);
  const closeSpaceMenu = useCallback(() => setSpaceMenu(null), []);
  const spaceMenuTarget = spaceMenu
    ? (spaces.find((space) => space.id === spaceMenu.id) ?? null)
    : null;
  const [clearTarget, setClearTarget] = useState<
    { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group } | null
  >(null);
  const [newSectionTarget, setNewSectionTarget] = useState<
    { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group } | null
  >(null);
  const [renameSectionTarget, setRenameSectionTarget] = useState<{
    section: BotSection;
    spaceId: string;
  } | null>(null);
  const [deleteSectionTarget, setDeleteSectionTarget] = useState<{
    section: BotSection;
    spaceId: string;
  } | null>(null);
  // The bot whose boot shows progress, and every bot whose boot request is still out.
  const [bootingBotId, setBootingBotId] = useState<string | null>(null);
  const booting = bootingBotId !== null && bootingBotId === computer?.botId;
  const bootsInFlight = useRef(new Map<string, symbol>());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [initialBotsLoaded, setInitialBotsLoaded] = useState(false);
  const [bootstrapMe, setBootstrapMe] = useState<Me | null>();
  const callsEnabledRef = useRef(false);
  useEffect(() => {
    callsEnabledRef.current = bootstrapMe?.phoneCallsEnabled === true;
  }, [bootstrapMe?.phoneCallsEnabled]);
  const currentSpaceId = selectedSpaceId() ?? bootstrapMe?.spaceId ?? null;
  // null: settings follow the space the app is showing.
  const [settingsSpaceId, setSettingsSpaceId] = usePreloadRecoveryState<string | null>(
    "settingsSpaceId",
    null,
  );
  const settingsSpace =
    spaces.find((space) => space.id === (settingsSpaceId ?? currentSpaceId)) ?? null;
  // Never fall back to another space's settings when the edited space goes away.
  const settingsSpaceGone = initialBotsLoaded && settingsSpaceId !== null && !settingsSpace;
  useEffect(() => {
    if (!settingsSpaceGone) return;
    setSettingsOpen(false);
    setSettingsSpaceId(null);
  }, [settingsSpaceGone]);
  const [keepComputerRecovery, setKeepComputerRecovery] = useState(false);
  const recoveryHoldTimer = useRef<number | undefined>(undefined);
  const showComputerRecoveryHint =
    computersAreUnavailable(bootstrapMe?.sandboxProvider) || keepComputerRecovery;
  const releaseComputerRecovery = useCallback(() => {
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = undefined;
    setKeepComputerRecovery(false);
  }, []);
  const holdComputerRecovery = useCallback(() => {
    setKeepComputerRecovery(true);
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = window.setTimeout(() => {
      recoveryHoldTimer.current = undefined;
      setKeepComputerRecovery(false);
    }, 4000);
  }, []);
  useEffect(() => {
    if (panel !== "computer") releaseComputerRecovery();
  }, [panel, releaseComputerRecovery]);
  useEffect(() => () => window.clearTimeout(recoveryHoldTimer.current), []);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);
  const [computerBotId, setComputerBotId] = useState<string | undefined>();
  const computerOpenRef = useRef(false);
  const computerBotIdRef = useRef<string | undefined>(undefined);
  const computerBootEpoch = useRef(0);
  const openComputerRef = useRef<(botId?: string) => Promise<boolean>>(async () => false);
  const [computerViewport, setComputerViewport] = useState<{
    height: number;
    offsetTop: number;
  } | null>(null);
  const [computerError, setComputerError] = useState<string | null>(null);
  // Screen-load failures can sit beside a still-valid embed URL; boot and
  // takeover failures must stay visible even when a URL remains.
  const [computerErrorFromScreen, setComputerErrorFromScreen] = useState(false);
  const computerErrorFromScreenRef = useRef(false);
  computerErrorFromScreenRef.current = computerErrorFromScreen;
  // The framed screen cannot be inspected from here. The proxy says when it refuses the page,
  // and the page reports its own state; nothing past "loading" by the timeout means it stalled.
  const [screenFrame, setScreenFrame] = useState<HTMLIFrameElement | null>(null);
  const [screenLoadError, setScreenLoadError] = useState<string | null>(null);
  const screenFrameReported = useRef(false);
  useEffect(() => {
    // Only a mounted frame resets the error: its own failure unmounts it, and Retry remounts it.
    if (!screenFrame) return;
    setScreenLoadError(null);
    screenFrameReported.current = false;
    const url = embeddableScreenUrl(screenUrl);
    if (!isProxiedScreenUrl(url)) return;
    let cancelled = false;
    const fallback = t`Could not connect to the computer screen`;
    void probeScreen(url, fallback).then((error) => {
      if (!cancelled && error && !screenFrameReported.current) setScreenLoadError(error);
    });
    const timer = setTimeout(() => {
      if (!cancelled && !screenFrameReported.current) setScreenLoadError(fallback);
    }, SCREEN_FRAME_LOAD_TIMEOUT_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [screenFrame, screenUrl]);
  useEffect(() => {
    if (!screenFrame) return;
    const fallback = t`Could not connect to the computer screen`;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== screenFrame.contentWindow) return;
      const message = screenFrameMessage(event.data);
      if (!message) return;
      if (screenFrameStarted(message)) screenFrameReported.current = true;
      setScreenLoadError(screenFrameError(message, fallback));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [screenFrame]);
  useEffect(() => {
    if (!computerOpen) {
      setComputerViewport(null);
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => {
      setComputerViewport({ height: viewport.height, offsetTop: viewport.offsetTop });
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
    };
  }, [computerOpen]);
  useEffect(() => {
    if (!session.data?.user) return;
    let cancelled = false;
    void rpc.messaging
      .status()
      .then((status) => {
        if (!cancelled) {
          setMessagingSurfaceEnabled(status.enabled);
          setMessagingProviders(status.providers);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session.data?.user]);
  const [usage, setUsage] = useState<{
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens?: number | null;
    runs: number;
  } | null>(null);
  const refreshUsage = useCallback(() => {
    void rpc.usage
      .summary()
      .then(setUsage)
      .catch(() => undefined);
  }, []);
  const autoBooted = useRef<string | null>(null);
  const bootstrappedThread = useRef<ThreadSnapshot | null>(null);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const jumpGeneration = useRef(0);
  const [scrollRequest, setScrollRequest] = useState<{
    messageId: string;
    nonce: number;
  } | null>(null);
  const clearScrollRequest = useCallback(() => setScrollRequest(null), []);
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
  const computerBot =
    (computerBotId ? bots.find((bot) => bot.id === computerBotId) : undefined) ?? active;
  computerOpenRef.current = computerOpen;
  computerBotIdRef.current = computerBotId ?? active?.id;
  useEffect(() => {
    setScreenLoadError(null);
  }, [computerBot?.id, screenUrl]);
  const activeGroup = groups.find((group) => group.id === groupId);
  const activePendingAttachments = useMemo(
    () => attachmentsForThread(pendingAttachments, inGroup ? groupId : active?.id),
    [active?.id, groupId, inGroup, pendingAttachments],
  );
  const activeRoutines = !inGroup && routinesBotId === active?.id ? routines : [];
  const panelTarget = inGroup ? activeGroup?.id : active?.id;
  const panelStorageKey =
    userId && bootstrapMe?.spaceId && panelTarget
      ? rightPanelStorageKey(userId, bootstrapMe.spaceId, inGroup ? "group" : "bot", panelTarget)
      : null;
  panelStorageKeyRef.current = panelStorageKey;
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
  const {
    editorProps: routineEditorProps,
    deleteDialogProps: deleteRoutineDialogProps,
    editingRoutine,
    restoreRoutine,
    editRoutine,
    startRoutine,
    resetRoutineTarget,
    leaveRoutine,
    addSkillRoutine,
  } = useRoutineEditor({
    rpc,
    active,
    activeBotId,
    timezone: bootstrapMe?.timezone,
    setBots,
    refreshThread,
    setPanel,
    messageProviders: messagingProviders,
  });
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
          archivedGroupList?.length === 0 &&
          !navigation.spaces.some((space) => space.hasContent)
        ) {
          // Only the very first bot everywhere needs onboarding. An empty
          // current space with content elsewhere stays in the app so the
          // space can be switched to or deleted instead of trapping the user.
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
    if (!computerOpenRef.current) commitComputer(null);
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
    return loadComputerScreen({
      load: () => rpc.computer.screenUrl({ botId: id }),
      isCurrent: () =>
        request === screenRequest.current &&
        (activeBotId.current === id || computerBotIdRef.current === id) &&
        computerVisible.current,
      commit: (screen) => {
        setScreenUrl(screen.url);
        // A screen read replaces only its own error; a failed boot keeps its error and Retry.
        if (screen.error || computerErrorFromScreenRef.current) {
          setComputerError(screen.error);
          setComputerErrorFromScreen(Boolean(screen.error));
        }
        cacheComputerFor(id, { screenUrl: screen.url });
      },
      fallbackError: t`Could not connect to the computer screen`,
    });
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
        // First sign-in with no saved timezone: adopt this browser's, once. A choice made
        // in Settings is never overwritten; a failure just leaves bots on UTC.
        if (bootstrap.me.timezone === null) {
          void rpc.preferences
            .adoptTimezone({ timezone: localTimezone() })
            .then((nextMe) => {
              if (!cancelled) {
                setBootstrapMe((current) =>
                  current && current.timezone == null
                    ? { ...current, timezone: nextMe.timezone }
                    : (current ?? nextMe),
                );
              }
            })
            .catch(() => {});
        }
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
          bootstrap.archivedGroups.length === 0 &&
          !bootstrap.spaces.some((space) => space.hasContent)
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
        void refreshBots(true).catch(() => undefined);
      });
    let refreshTimer: number | undefined;
    const refreshVisibleBots = () => {
      if (document.visibilityState !== "visible" && !callsEnabledRef.current) return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(
        () =>
          void refreshBots().catch((error) => {
            if (!isRetryableError(error)) window.clearInterval(poll);
          }),
        50,
      );
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
    return () => {
      unsubSpeech();
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
    if (call?.botId === active.id || !active.autoSpeak) {
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (snapshot.run && ["running", "queued", "leased"].includes(snapshot.run.status)) return;
    if (!lastBot || lastBot.id === autoSpoken.current) return;
    const text = speechFromBlocks(lastBot.blocks);
    if (!text) return;
    autoSpoken.current = lastBot.id;
    readAloud(text, { botId: active.id, messageId: lastBot.id });
  }, [
    snapshot?.messages,
    snapshot?.run?.status,
    snapshot?.botId,
    active?.autoSpeak,
    active?.id,
    call?.botId,
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
    setComputerError(null);
    setComputerErrorFromScreen(false);
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
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: async () => {
        const primed = bootstrappedThread.current;
        bootstrappedThread.current = null;
        // Pending search jumps load the around-page separately; avoid replacing it with latest.
        return primed?.botId === active.id
          ? primed
          : pendingJump
            ? rpc.threads.get({ botId: active.id }, { signal: threadSnapshotSignal(abort.signal) })
            : refreshThread(active.id, threadSnapshotSignal(abort.signal));
      },
      loadHead: () =>
        rpc.threads.head({ botId: active.id }, { signal: threadSnapshotSignal(abort.signal) }),
      refresh: () => refreshThread(active.id, threadSnapshotSignal(abort.signal)),
      currentSnapshot: () => snapshotRef.current,
      subscribe: (cursor, signal) =>
        rpc.threads.subscribe({ botId: active.id, cursor }, { signal }),
      beforeEvent: (event) => {
        if (isRunTerminalEvent(event) && event.runId) {
          terminalRunReceipts.current.add(event.runId);
          if (terminalRunReceipts.current.size > 100) {
            const oldest = terminalRunReceipts.current.values().next().value;
            if (oldest !== undefined) terminalRunReceipts.current.delete(oldest);
          }
        }
      },
      applyEvent: (event) =>
        applyThreadEvent(event, commitSnapshot, commitComputer, snapshotRef, computerRef),
      onEvent: (event, initial) => {
        const currentBot = botsRef.current.find((bot) => bot.id === active.id);
        notifyBrowserForEvent(
          event,
          initial.threadId,
          initial.cursor,
          true,
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
          event.type === "bot.updated" ||
          event.type === "group.created" ||
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
      },
    });
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
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: () =>
        pendingJump
          ? rpc.threads.get({ groupId }, { signal: threadSnapshotSignal(abort.signal) })
          : refreshGroupThread(groupId, threadSnapshotSignal(abort.signal)),
      loadHead: () => rpc.threads.head({ groupId }, { signal: threadSnapshotSignal(abort.signal) }),
      refresh: () => refreshGroupThread(groupId, threadSnapshotSignal(abort.signal)),
      currentSnapshot: () => snapshotRef.current,
      subscribe: (cursor, signal) => rpc.threads.subscribe({ groupId, cursor }, { signal }),
      applyEvent: (event) =>
        applyThreadEvent(
          event,
          commitSnapshot,
          (next) => {
            if (isComputerStatusEvent(event) && event.botId !== computerBotIdRef.current) return;
            commitComputer(next);
          },
          snapshotRef,
          computerRef,
        ),
      onEvent: (event, initial) => {
        const eventBot = botsRef.current.find((bot) => bot.id === event.botId);
        notifyBrowserForEvent(
          event,
          initial.threadId,
          initial.cursor,
          true,
          eventBot?.name ?? activeGroup.name,
          true,
          true,
        );
        if (event.type === "thread.message.created" && event.payload.role === "bot") {
          readVisibleGroups.current.delete(groupId);
          markVisibleGroupRead();
        }
        if (
          event.type === "run.started" ||
          event.type === "bot.updated" ||
          event.type === "group.updated" ||
          isRunTerminalEvent(event)
        ) {
          void refreshBots().catch(() => undefined);
        }
        if (isRunTerminalEvent(event) || event.type === "run.waiting_input") {
          // waiting_input: reconcile ask cards if a stale post-send refresh raced SSE.
          void refreshGroupThread(groupId).catch(() => undefined);
        }
      },
    });
    return () => {
      window.removeEventListener("focus", markVisibleGroupRead);
      document.removeEventListener("visibilitychange", markVisibleGroupRead);
      abort.abort();
    };
  }, [activeGroup?.id, groupId, notifyBrowserForEvent]);

  const sidebarSpaces = useMemo(
    () =>
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
                hasContent: true,
                canRename: false,
                canDelete: false,
                bots,
                groups,
                botSections,
              },
            ]
          : [],
    [bootstrapMe, botSections, bots, groups, spaces],
  );
  const sidebarGroups = useMemo(
    () =>
      sidebarGroupsForSpaces(sidebarSpaces, miniSidebar ? "" : query, {
        pinned: t`Pinned`,
        unassigned: t`Unassigned`,
      }),
    [sidebarSpaces, query, miniSidebar, t],
  );
  // The Dock badge ignores the roster search box: a filter must not hide unread chats.
  const unreadChatCount = useMemo(
    () => countUnreadChats(sidebarGroupsForSpaces(sidebarSpaces, "")),
    [sidebarSpaces],
  );
  useDesktopBadge(userId ? unreadChatCount : 0);

  const spaceSwitchRequest = useRef(0);
  useEffect(
    () => () => {
      // A switch still loading when this shell goes away (another page, or a
      // newer switch) must not pull the user back to its space afterwards.
      spaceSwitchRequest.current += 1;
    },
    [],
  );
  const openSpaceChat = useCallback(
    (spaceId: string, path: string) => {
      setMobileSidebarOpen(false);
      const request = ++spaceSwitchRequest.current;
      const previousEffective = selectedSpaceId() ?? bootstrapMe?.spaceId;
      // Persist the active space (including primary) so voice/RPC headers match the chat.
      if (previousEffective === spaceId) {
        if (selectSpace(spaceId)) navigate(path);
        return;
      }
      const reload = () => {
        if (selectSpace(spaceId)) window.location.assign(path);
      };
      // Another space is an auth boundary: its bootstrap is loaded first, under that
      // space's header, then the shell remounts so none of this space's state survives.
      // A call in progress, or a page outside the shell, still reloads.
      const target = initialBootstrapTarget(path, false);
      if (!target || getCallSnapshot()) {
        reload();
        return;
      }
      const startedAt = window.location.pathname;
      const decision = () =>
        spaceSwitchDecision(
          request === spaceSwitchRequest.current,
          startedAt,
          window.location.pathname,
          Boolean(getCallSnapshot()),
        );
      const current = () => decision() !== "abandon";
      const primed = primeSpaceBootstrap(spaceId, target.botId);
      primed.then(
        () => {
          if (!current()) {
            discardPrimedBootstrap(primed);
            return;
          }
          // A call started while the bootstrap loaded belongs to this space.
          if (getCallSnapshot()) {
            discardPrimedBootstrap(primed);
            reload();
            return;
          }
          remountShellForSpace(() => {
            const action = decision();
            if (action !== "commit") {
              discardPrimedBootstrap(primed);
              if (action === "reload") {
                // Leave the view-transition update before starting a full navigation.
                window.setTimeout(() => {
                  if (current()) reload();
                }, 0);
              }
              return false;
            }
            if (!selectSpace(spaceId)) {
              discardPrimedBootstrap(primed);
              return false;
            }
            // Playback belongs to the conversation being left.
            speaker.stop();
            navigate(path);
            return true;
          });
        },
        () => {
          discardPrimedBootstrap(primed);
          if (current()) reload();
        },
      );
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
  // Drags only act on bots of the active space; other spaces are read-only here.
  const draggedBot = draggedBotId ? bots.find((bot) => bot.id === draggedBotId) : undefined;
  const rosterDropAction = useCallback(
    (target: RosterDropTarget, sameParent: boolean) =>
      draggedBot ? resolveRosterDrop({ dragged: draggedBot, target, sameParent }) : null,
    [draggedBot],
  );
  const applyRosterDrop = useCallback(
    (target: RosterDropTarget, sameParent: boolean, groupBotIds: string[]) => {
      const action = rosterDropAction(target, sameParent);
      setDraggedBotId(null);
      setRosterDropKey(null);
      if (!action || !draggedBot) return;
      setSendError(null);
      if (action.action === "reorder") {
        reorderRosterBot(draggedBot.id, action.targetBotId, groupBotIds);
        return;
      }
      const request =
        action.action === "move"
          ? rpc.bots.update({ botId: draggedBot.id, sectionId: action.sectionId })
          : rpc.groups.update({
              groupId: action.groupId,
              botIds: action.botIds,
              expectedBotIds: action.botIds.filter((id) => id !== draggedBot.id),
            });
      void request
        .then(async () => {
          await refreshBots();
          if (action.action === "join" && activeGroupId.current === action.groupId) {
            await refreshGroupThread(action.groupId);
          }
        })
        .catch((error) => {
          setSendError(errorText(error, t`Could not save`));
          void refreshBots().catch(() => undefined);
        });
    },
    [draggedBot, refreshBots, reorderRosterBot, rosterDropAction, t],
  );
  const spaceQuery = query.trim();
  const showSpaceSearch = !activityMode && spaceQuery.length > 0;

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
    // A reply folded under its peer marker counts: the transcript expands the marker to show it.
    const pageTranscript = foldPeerReplies(page.messages, { includePeerReceipts: true });
    const targetInPage =
      pageTranscript.markerOf.has(target.messageId) ||
      pageTranscript.messages.some((message) => message.id === target.messageId);
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
    if (targetInPage) {
      // The transcript owns the scroll: it retries until the pinned row is
      // mounted and unfollows the tail, so live commits cannot cancel it.
      setScrollRequest({ messageId: target.messageId, nonce: jumpId });
    } else {
      window.requestAnimationFrame(() => {
        if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
        const element = messageScroll.current;
        if (element) {
          element.scrollTop = element.scrollHeight;
          initiallyScrolledThread.current = page.threadId;
        }
      });
    }
  }

  // The routine panel copies a routine's data into local draft state at click time
  // rather than deriving it from `active`, so it goes stale across a bot switch —
  // without this, Save on bot B could silently update bot A's routine.
  useEffect(() => {
    resetRoutineTarget();
    setPanelState((current) => (current === "routine" ? null : current));
  }, [active?.id]);

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
        editRoutine(routine);
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
  // Keep the armed reply even when its parent leaves the loaded page: the
  // server resolves a paged-out target and degrades a deleted one to a plain
  // reply instead of failing the send.
  const activeReplyTarget = replyTarget;
  const activeReplyQuote = replyTarget ? replyQuote : null;
  const clearReply = useCallback(() => {
    setReplyTarget(null);
    setReplyQuote(null);
  }, []);
  const currentRuns = activeThreadRuns(activeSnapshot);
  const answerableAskIds = useMemo(() => answerableAskMessageIds(activeSnapshot), [activeSnapshot]);
  const dismissableAskIds = useMemo(
    () => dismissableAskMessageIds(activeSnapshot, userId),
    [activeSnapshot, userId],
  );
  const workingRuns = currentRuns.filter((run) => isRunWorking(run.status));
  const transcriptRunning = workingRuns.length > 0;
  const composerRunning = currentRuns.some((run) => isActive(run.status));
  const runError = threadRunError(activeSnapshot, dismissedRunErrorIds);
  const displayedRunError = !sendError ? runError : null;
  const displayedRunErrorId = displayedRunError ? (activeSnapshot?.run?.id ?? null) : null;
  const handleRunErrorPresented = useCallback((runId: string) => {
    rememberSeenRunErrorId(runId);
  }, []);
  const transcript = useMemo(
    () => foldPeerReplies(activeSnapshot?.messages ?? [], { includePeerReceipts: true }),
    [activeSnapshot?.messages],
  );
  const transcriptRef = useRef(transcript);
  useLayoutEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);
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
      color: bot?.color ?? FALLBACK_BOT_COLOR,
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
      if (!initialBotsLoaded) return;
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
    // The catalog call reconciles connection rows, so list them after it.
    const catalogRequest = rpc.connections.catalog({}).catch(() => null);
    void Promise.all([
      catalogRequest.then(() => rpc.connections.list().catch(() => null)),
      catalogRequest,
    ]).then(([connections, catalog]) => {
      if (cancelled) return;
      const connected = connections?.filter((row) => row.status === "connected") ?? [];
      if (catalog && connections) setFooterLogos(connectedAppMarks(catalog, connections));
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
      for (const item of catalog ?? []) {
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
      setMentionConnectors(bots.length ? options : []);
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
      markShellReady();
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
    const inTranscript =
      transcriptRef.current.markerOf.has(messageId) ||
      document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (inTranscript) {
      // Cancel any in-flight around-fetch so it cannot overwrite this scroll.
      jumpGeneration.current += 1;
      setScrollRequest({ messageId, nonce: jumpGeneration.current });
      return;
    }
    const groupId = activeGroupId.current;
    if (groupId) {
      void jumpToMessageRef.current({ groupId, messageId }).catch(() => undefined);
      return;
    }
    const botId = activeBotId.current;
    if (botId) void jumpToMessageRef.current({ botId, messageId }).catch(() => undefined);
  }, []);
  const answerMessage = useCallback(
    async (message: ThreadMessage, text: string, username?: string, dismiss?: boolean) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      await rpc.threads.answer({
        ...(groupId ? { groupId } : { botId: botId! }),
        runId: message.runId ?? "",
        messageId: message.id,
        answer: text,
        ...(username ? { username } : {}),
        ...(dismiss ? { dismiss: true as const } : {}),
      });
      // The answer is saved; live events can reconcile a failed refresh.
      try {
        if (groupId && activeGroupId.current === groupId) {
          await refreshGroupThreadRef.current(groupId);
        } else if (botId && activeBotId.current === botId) {
          await refreshThreadRef.current(botId);
        }
      } catch {}
    },
    [],
  );
  const reactToMessage = useCallback(
    async (message: ThreadMessage, reaction: MessageReaction) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      try {
        const result = await rpc.threads.react({
          ...(groupId ? { groupId } : { botId: botId! }),
          messageId: message.id,
          reaction,
          clientNonce: newClientId(),
        });
        if (result.runIds?.length) {
          // The reaction is saved; a failed refresh is caught up by live events.
          try {
            if (groupId && activeGroupId.current === groupId) {
              await refreshGroupThreadRef.current(groupId);
            } else if (botId && activeBotId.current === botId) {
              await refreshThreadRef.current(botId);
            }
          } catch {}
        }
      } catch (error) {
        const stillHere = groupId
          ? activeGroupId.current === groupId
          : activeBotId.current === botId;
        if (!stillHere) return;
        setSendError(errorText(error, t`Could not update reaction`));
      }
    },
    [t],
  );
  const onAttachmentPick = useCallback(
    (files: FileList | null) => {
      const threadKey = activeGroupId.current ?? activeBotId.current;
      if (!threadKey || !files?.length) return false;
      const existing = attachmentsForThread(pendingAttachments, threadKey);
      const next: PendingAttachment[] = [];
      const skipped: string[] = [];
      for (const file of Array.from(files)) {
        if (existing.length + next.length >= ATTACHMENT_MAX_COUNT) {
          skipped.push(t`${file.name} (max ${ATTACHMENT_MAX_COUNT} attachments)`);
          continue;
        }
        if (file.size > attachmentMaxBytes(bootstrapMe)) {
          skipped.push(
            t`${file.name} (over ${attachmentSizeLabel(attachmentMaxBytes(bootstrapMe))})`,
          );
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
      return next.length > 0;
    },
    [pendingAttachments, bootstrapMe, t],
  );
  const removeAttachment = useCallback((attachment: PendingAttachment) => {
    revokePendingAttachmentPreviews([attachment]);
    setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id));
  }, []);
  const sendMessage = useCallback(
    async (text: string, mentions: ComposerMention[], clientNonce: string) => {
      const initialBotTarget = activeBotId.current;
      const initialGroupTarget = activeGroupId.current;
      if ((!initialBotTarget && !initialGroupTarget) || sending) return false;
      const originThreadKey = initialGroupTarget ?? initialBotTarget;
      const attachments = attachmentsForThread(pendingAttachments, originThreadKey);
      const plan = resolveComposerSendPlan({
        text,
        mentions,
        hasAttachments: attachments.length > 0,
      });
      if (plan.isNoOp) return false;
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
      sendingRef.current = true;
      setSending(true);
      setSendError(null);
      const dropDelayedSetup = () => {
        // Only after successful engagement so a failed upload/send keeps the setup card.
        if (initialBotTarget && focusPromptBotIdRef.current === initialBotTarget) {
          cancelFocusPrompt();
        }
      };
      // Keep the draft cleared once any part of the submission is confirmed accepted.
      let accepted = false;
      try {
        if (plan.shouldRunRoutines) {
          // Settle every run first so one that was accepted is never repeated.
          const runs = await Promise.allSettled(
            plan.routineIds.map((routineId) =>
              rpc.routines.testRun({
                routineId,
                clientNonce: `routine-mention:${clientNonce}:${routineId}`,
              }),
            ),
          );
          accepted = runs.some((run) => run.status === "fulfilled");
          for (const run of runs) if (run.status === "rejected") throw run.reason;
        }
        if (!plan.shouldSend) {
          dropDelayedSetup();
          clearReply();
          revokePendingAttachmentPreviews(attachments);
          setPendingAttachments((current) =>
            current.filter((attachment) => attachment.threadKey !== originThreadKey),
          );
          setAttachmentNotice(null);
          if (reroutedToGroup && groupTarget) {
            navigate(`/app/g/${groupTarget}`);
            return true;
          }
          if (groupTarget && activeGroupId.current === groupTarget) {
            await refreshGroupThreadRef.current(groupTarget);
          } else if (botTarget && activeBotId.current === botTarget) {
            await refreshThreadRef.current(botTarget);
          }
          return true;
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
        if (groupTarget) {
          await rpc.threads.send({
            groupId: groupTarget,
            clientNonce,
            text: trimmed || undefined,
            mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
            artifactIds: artifactIds.length ? artifactIds : undefined,
            replyToMessageId: reroutedToGroup ? undefined : activeReplyTarget?.id,
            replyQuote: reroutedToGroup ? undefined : (activeReplyQuote ?? undefined),
          });
          accepted = true;
        } else if (botTarget) {
          const sent = await rpc.threads.send({
            botId: botTarget,
            clientNonce,
            text: trimmed || undefined,
            mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
            artifactIds: artifactIds.length ? artifactIds : undefined,
            replyToMessageId: activeReplyTarget?.id,
            replyQuote: activeReplyQuote ?? undefined,
          });
          accepted = true;
          if (activeBotId.current === botTarget) {
            updateSnapshot((current) =>
              applyThreadSendReceipt(
                current,
                {
                  botId: botTarget,
                  runId: sent.runId,
                  taskId: sent.taskId,
                },
                terminalRunReceipts.current,
              ),
            );
          }
        }
        dropDelayedSetup();
        clearReply();
        revokePendingAttachmentPreviews(attachments);
        setPendingAttachments((current) =>
          current.filter((attachment) => attachment.threadKey !== originThreadKey),
        );
        // Refresh sidebar status even when a bot→group reroute navigates away below.
        void refreshBots().catch(() => undefined);
        if (reroutedToGroup && groupTarget) {
          navigate(`/app/g/${groupTarget}`);
          return true;
        }
        if (groupTarget && activeGroupId.current === groupTarget) setAttachmentNotice(null);
        if (botTarget && activeBotId.current === botTarget) setAttachmentNotice(null);
        if (groupTarget) void refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
        else if (botTarget) void refreshThreadRef.current(botTarget).catch(() => undefined);
        return true;
      } catch (error) {
        if (reroutedToGroup && groupTarget) {
          setSendError(errorText(error, t`Failed to send message`));
        } else if (groupTarget && activeGroupId.current === groupTarget) {
          setSendError(errorText(error, t`Failed to send message`));
        } else if (botTarget && activeBotId.current === botTarget) {
          setSendError(errorText(error, t`Failed to send message`));
        }
        return accepted;
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [
      activeReplyTarget?.id,
      activeReplyQuote,
      clearReply,
      flushPendingBrowserNotifications,
      navigate,
      pendingAttachments,
      sending,
      t,
    ],
  );
  const stopRun = useCallback(async () => {
    if (sending) return;
    sendingRef.current = true;
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
            setSendError(errorText(error, t`Failed to stop`));
          }
          return;
        }
        // Clear run UI ahead of the run.cancelled event so refresh races with in-flight gets.
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
          setSendError(errorText(error, t`Failed to stop`));
        }
        return;
      }
      // Clear local run/busy immediately rather than waiting for run.cancelled so a
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
      sendingRef.current = false;
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
  // Teach chrome needs skills applied before this resolves — refreshThread only
  // kicks skills.list off in the background, so Stop teaching would never mount
  // if that background call failed or lagged behind local recovery.
  const refreshActiveTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
    const skills = await rpc.skills.list({ botId: id });
    if (activeBotId.current !== id) return;
    setTaughtSkills(skills);
    setTaughtSkillsBotId(id);
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
    if (text && id) readAloud(text, { botId: id, messageId: message.id });
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

  function cancelFocusPrompt() {
    focusPromptAbortRef.current?.abort();
    focusPromptAbortRef.current = null;
    focusPromptBotIdRef.current = null;
  }

  function setBotsSidebarCollapsedPref(collapsed: boolean) {
    setBotsSidebarCollapsed(collapsed);
    writeBotsSidebarCollapsed(userId, collapsed);
  }

  function openSettings(section: SettingsSection = "general") {
    setSettingsSpaceId(null);
    setSettingsSection(section);
    setSettingsOpen(true);
  }

  // Space-scoped sections bind their own rpc client to this space, so another
  // space's settings open in place without switching the app or reloading.
  function openSpaceSettings(spaceId: string) {
    openSettings("models");
    setSettingsSpaceId(spaceId);
  }

  async function createBot(input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
  }) {
    const isFirstBot = botsRef.current.length === 0;
    const bot = await rpc.bots.create({
      ...normalizeCreateBotProfile(input),
      notifyOnFinish: true,
      computerMode: input.computerMode,
    });
    // A roster requested before creation may omit this bot and redirect its new chat.
    botsRefreshEpoch.current += 1;
    setBots((current) =>
      current.some((item) => item.id === bot.id) ? current : [bot, ...current],
    );
    navigate(`/app/${bot.id}`);
    setPanel(null);
    // Register cancellation before awaiting start so leaving the bot during
    // startup cannot miss the abort and still schedule a late focus card.
    cancelFocusPrompt();
    const controller = new AbortController();
    focusPromptAbortRef.current = controller;
    focusPromptBotIdRef.current = bot.id;
    const started = await rpc.onboarding
      .start({ botId: bot.id })
      .then(() => true)
      .catch(() => false);
    if (!started || controller.signal.aborted || focusPromptBotIdRef.current !== bot.id) {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
      await refreshBots().catch(() => undefined);
      return;
    }
    void scheduleFocusPrompt({
      immediate: isFirstBot,
      signal: controller.signal,
      shouldSkip: () => sendingRef.current,
      prompt: async () => {
        if (focusPromptBotIdRef.current !== bot.id || activeBotId.current !== bot.id) return;
        await rpc.onboarding.promptFocus({ botId: bot.id }).catch(() => undefined);
      },
    }).finally(() => {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
    });
    await refreshBots().catch(() => undefined);
  }

  async function bootComputer({
    botId: targetBotId,
    takeControl,
    showProgress,
    force = false,
  }: {
    botId: string;
    takeControl: boolean;
    showProgress: boolean;
    force?: boolean;
  }) {
    const epoch = ++computerBootEpoch.current;
    const stillThisBoot = () => computerBootEpoch.current === epoch;
    const stillThisBot = () =>
      computerBotIdRef.current === targetBotId || activeBotId.current === targetBotId;
    const cached = computerCacheRef.current.get(targetBotId);
    const targetComputer = computer?.botId === targetBotId ? computer : (cached?.computer ?? null);
    const targetScreen = computer?.botId === targetBotId ? screenUrl : (cached?.screenUrl ?? null);
    const needsBoot = force || targetComputer?.state !== "running" || !targetScreen;
    if (showProgress && needsBoot) setBootingBotId(targetBotId);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    try {
      if (needsBoot) {
        const status = await bootComputerOnce(bootsInFlight.current, targetBotId, () =>
          rpc.computer.boot({ botId: targetBotId }),
        );
        if (!stillThisBoot() || !stillThisBot()) return;
        if (status) {
          commitComputer(status);
          cacheComputerFor(targetBotId, { computer: status });
        }
      }
      if (takeControl) {
        await rpc.computer.takeover({ botId: targetBotId });
        if (!stillThisBoot() || !stillThisBot()) return;
      }
      await refreshComputerFor(targetBotId);
    } catch (error) {
      if (!stillThisBoot() || !stillThisBot()) return;
      setComputerError(errorText(error, t`Could not take control`));
      setComputerErrorFromScreen(false);
      throw error;
    } finally {
      if (stillThisBoot()) setBootingBotId(null);
    }
  }

  async function refreshComputerFor(targetBotId: string) {
    if (activeBotId.current === targetBotId) {
      await refreshThread(targetBotId);
      return;
    }
    if (computerBotIdRef.current !== targetBotId) return;
    const status = await rpc.computer.status({ botId: targetBotId });
    if (computerBotIdRef.current !== targetBotId) return;
    commitComputer(status);
    cacheComputerFor(targetBotId, { computer: status });
    await refreshComputerScreen(targetBotId);
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
      if (!computerPanelNeedsScreen(state, screen) || autoBooted.current === botId) return;
      autoBooted.current = botId;
      await bootComputer({
        botId,
        takeControl: false,
        showProgress: false,
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
    setComputerErrorFromScreen(false);
    setComputerBotId(active?.id);
  }, [active?.id]);

  useEffect(() => {
    if (focusPromptBotIdRef.current && focusPromptBotIdRef.current !== active?.id) {
      cancelFocusPrompt();
    }
  }, [active?.id]);

  useEffect(() => () => cancelFocusPrompt(), []);

  useEffect(() => {
    if (!computer?.busyBotName) {
      setComputerError(null);
      setComputerErrorFromScreen(false);
    }
  }, [computer?.busyBotName]);

  useEffect(() => {
    if (panel !== "routine") {
      leaveRoutine();
    }
  }, [panel]);

  useEffect(() => {
    if (!panelStorageKey) return;
    if (observedPanelKey.current !== panelStorageKey) {
      observedPanelKey.current = panelStorageKey;
      if (pendingExplicitPanel.current || explicitPanelTarget.current === panelStorageKey) {
        pendingExplicitPanel.current = false;
        explicitPanelTarget.current = null;
        pendingPanelRestore.current = null;
        setRestoredPanelKey(panelStorageKey);
        return;
      }
      explicitPanelTarget.current = null;
      // Reload starts with panel=null so storage restores. In-session chat switches used to
      // keep computer/settings open; only routine was cleared (handled above). Carry is
      // session-only — do not write the carried panel onto the destination's saved prefs.
      if (panel === "computer" || panel === "settings" || panel === "group-settings") {
        const carried = panel === "computer" ? "computer" : inGroup ? "group-settings" : "settings";
        pendingPanelRestore.current = null;
        if (carried !== panel) setPanelState(carried);
        setRestoredPanelKey(null);
        return;
      }
      pendingPanelRestore.current = readRightPanelState(panelStorageKey);
    }
    const saved = pendingPanelRestore.current;
    if (!saved) return;
    // Explicit routine links take precedence over a local layout preference.
    if (searchParams.has("routine")) {
      pendingPanelRestore.current = null;
      return;
    }
    if (saved.panel === "routine" && saved.routineId && routinesBotId !== active?.id) return;
    let next = saved.panel;
    if (next === "routine") {
      const routine = saved.routineId
        ? routines.find((item) => item.id === saved.routineId)
        : undefined;
      if (saved.routineId && !routine) next = "computer";
      restoreRoutine(routine ?? null);
    }
    pendingPanelRestore.current = null;
    setPanelState(next);
    setRestoredPanelKey(panelStorageKey);
  }, [panelStorageKey, active?.id, inGroup, panel, routinesBotId, routines, searchParams]);

  useEffect(() => {
    // Do not gate writes on ?routine= staying in the URL — a stuck/failed routine
    // list would freeze layout prefs. Deep-link handling uses setPanelState for the
    // bot-switch close so restoredPanelKey stays unset until an intentional setPanel.
    if (!panelStorageKey || restoredPanelKey !== panelStorageKey || pendingPanelRestore.current)
      return;
    writeRightPanelState(panelStorageKey, panel, editingRoutine?.id);
  }, [panelStorageKey, restoredPanelKey, panel, editingRoutine?.id]);

  useEffect(() => {
    const threadKey = inGroup ? groupId : active?.id;
    setPendingAttachments((current) => {
      const stale = current.filter((attachment) => attachment.threadKey !== threadKey);
      revokePendingAttachmentPreviews(stale);
      return attachmentsForThread(current, threadKey);
    });
    clearReply();
    setAttachmentNotice(null);
    setSendError(null);
  }, [active?.id, clearReply, groupId, inGroup]);

  useEffect(() => {
    if (!computerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setComputerOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [computerOpen]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!isCommandPaletteHotkey(event)) return;
      event.preventDefault();
      setCommandPaletteOpen((open) => !open);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const heartbeatBotId = computerBot?.id ?? active?.id;
    if ((panel !== "computer" && !computerOpen) || !heartbeatBotId || computer?.state !== "running")
      return;
    // A computer panel left open in a hidden window must not keep the computer awake.
    const ping = () => {
      if (document.visibilityState !== "visible") return;
      void rpc.computer.heartbeat({ botId: heartbeatBotId }).catch((error) => {
        if (!isRetryableError(error)) window.clearInterval(timer);
      });
    };
    const timer = window.setInterval(ping, 60_000);
    ping();
    return () => window.clearInterval(timer);
  }, [panel, computerOpen, computerBot?.id, active?.id, computer?.state]);

  /** Open the computer view. Only an explicit Take control asks for the lease. */
  async function openComputer(botId?: string, takeControl = false) {
    const id = botId ?? active?.id;
    if (!id) return false;
    const bot = botsRef.current.find((candidate) => candidate.id === id);
    if (!bot) return false;
    computerBotIdRef.current = id;
    setComputerBotId(id);
    const cached = computerCacheRef.current.get(id);
    const targetComputer = computer?.botId === id ? computer : (cached?.computer ?? null);
    const targetScreen = computer?.botId === id ? screenUrl : (cached?.screenUrl ?? null);
    if (computer?.botId !== id) {
      commitComputer(targetComputer);
      setScreenUrl(targetScreen);
    }
    // Reopening during a boot shows it; a second boot would be refused as busy.
    const bootInFlight = bootsInFlight.current.has(id) || targetComputer?.state === "booting";
    setComputerOpen(true);
    computerVisible.current = true;
    if (bootInFlight && !takeControl) return true;
    const needsTakeover = takeControl && !userHoldsComputerControl(targetComputer, id);
    const blocked = computerTakeoverBlocked(targetComputer, snapshot?.run?.status);
    try {
      await bootComputer({
        botId: id,
        takeControl: needsTakeover && !blocked,
        showProgress: (needsTakeover && !blocked) || targetComputer?.state !== "running",
        force: targetComputer?.state !== "running",
      });
      return true;
    } catch {
      // computerError already set in bootComputer
      return false;
    }
  }
  openComputerRef.current = openComputer;
  const onOpenComputer = useCallback((botId?: string) => {
    void openComputerRef.current(botId);
  }, []);

  async function releaseComputer(reason?: ComputerReleaseReason) {
    const botId = computerBotIdRef.current ?? activeBotId.current;
    if (!botId) return;
    try {
      await rpc.computer.release({ botId, reason });
      if (computerBotIdRef.current !== botId && activeBotId.current !== botId) return;
      await refreshComputerFor(botId).catch(() => undefined);
      const groupId = activeGroupId.current;
      if (groupId) {
        await refreshGroupThreadRef.current(groupId).catch(() => undefined);
      }
    } catch {
      if (computerBotIdRef.current !== botId && activeBotId.current !== botId) return;
      setComputerError(t`Could not continue`);
      setComputerErrorFromScreen(false);
    }
  }

  function dismissComposerError() {
    // The strip shows one message at a time, so only dismiss the run failure when it is the
    // one on screen; otherwise a live run would be silenced before it has even failed.
    const failedRunId = displayedRunErrorId;
    setSendError(null);
    if (failedRunId) {
      rememberSeenRunErrorId(failedRunId);
      setDismissedRunErrorIds((current) => new Set(current).add(failedRunId));
    }
  }

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl);
  const hasControl = userHoldsComputerControl(computer, computerBot?.id);
  const hideScreenLoadError = computerErrorFromScreen && Boolean(embeddedScreenUrl);
  const computerFailure =
    computerError && !hideScreenLoadError
      ? computerError
      : screenLoadError
        ? screenLoadError
        : !booting && computer?.state === "error"
          ? t`Computer failed to boot`
          : null;
  const computerScreenError = computerFailure ? (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 text-center text-sm">
      <p className="text-destructive">{computerFailure}</p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          if (!computerBot) return;
          setScreenLoadError(null);
          if (computer?.state === "running") {
            // An explicit retry clears any error; background screen reads clear only their own.
            setComputerError(null);
            setComputerErrorFromScreen(false);
            void refreshComputerScreen(computerBot.id);
          } else
            void bootComputer({
              botId: computerBot.id,
              takeControl: false,
              showProgress: true,
              force: true,
            }).catch(() => undefined);
        }}
      >
        <Trans>Retry screen</Trans>
      </Button>
    </div>
  ) : null;
  // Booting shows inline with the screen's own Close; leaving it lets the boot finish.
  const computerBooting =
    booting || computer?.state === "booting" ? (
      <span className="flex flex-col items-center gap-3">
        <Spinner aria-hidden className="size-5 motion-reduce:animate-none" />
        {t`Booting live desktop…`}
      </span>
    ) : null;
  const computerPreviewScreen =
    !computerOpen &&
    computer?.kind !== "desktop" &&
    computer?.state === "running" &&
    Boolean(embeddedScreenUrl) &&
    !computerScreenError;
  const showingRecoveryHint =
    !computerOpen &&
    computer?.kind !== "desktop" &&
    !computerPreviewScreen &&
    !computerScreenError &&
    showComputerRecoveryHint;

  const { label: userName, initial: initials } = accountDisplay(session.data?.user ?? {}, t`You`);

  const botMenuContent = contextChat ? (
    <BotContextMenu
      bot={contextChat}
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
          contextBot ? { kind: "bot", chat: contextBot } : { kind: "group", chat: contextGroup! },
        );
        setBotMenu(null);
      }}
      onRenameSection={(sectionId) => {
        const section = botSections.find((item) => item.id === sectionId);
        const spaceId = bootstrapMe?.spaceId;
        if (section && spaceId) setRenameSectionTarget({ section, spaceId });
        setBotMenu(null);
      }}
      onEdit={() => {
        const destKey =
          userId && bootstrapMe?.spaceId
            ? rightPanelStorageKey(
                userId,
                bootstrapMe.spaceId,
                contextBot ? "bot" : "group",
                contextChat.id,
              )
            : null;
        explicitPanelTarget.current = destKey;
        pendingPanelRestore.current = null;
        navigate(contextBot ? `/app/${contextBot.id}` : `/app/g/${contextGroup!.id}`);
        // Mark the destination key restored so we do not write settings onto the source chat.
        setPanelState(contextBot ? "settings" : "group-settings");
        setRestoredPanelKey(destKey);
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
          contextBot ? { kind: "bot", chat: contextBot } : { kind: "group", chat: contextGroup! },
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
  ) : null;
  const shell = (
    <BotsSidebarLayout
      userId={userId}
      collapsed={botsSidebarCollapsed}
      onCollapsedChange={setBotsSidebarCollapsedPref}
      computerOpen={computerOpen}
      data-testid="shell-root"
      data-ready={shellReady}
      className="relative flex h-full min-h-0 min-w-0 overflow-hidden bg-background text-foreground/90 [&[data-resizing-sidebar]_*[data-slot=sidebar-gap]]:transition-none [&[data-resizing-sidebar]_*[data-slot=sidebar-container]]:transition-none"
      onTouchStartCapture={(event) => {
        if (
          mobileSidebarOpen ||
          event.touches.length !== 1 ||
          window.matchMedia("(min-width: 768px)").matches
        ) {
          mobileSidebarSwipeRef.current = null;
          return;
        }
        const touch = event.touches[0];
        if (!touch) return;
        const rtl = document.documentElement.getAttribute("dir") === "rtl";
        const startsAtEdge = rtl
          ? touch.clientX >= window.innerWidth - MOBILE_SIDEBAR_SWIPE_EDGE_PX
          : touch.clientX <= MOBILE_SIDEBAR_SWIPE_EDGE_PX;
        mobileSidebarSwipeRef.current = startsAtEdge
          ? { startX: touch.clientX, startY: touch.clientY }
          : null;
      }}
      onTouchEndCapture={(event) => {
        const swipe = mobileSidebarSwipeRef.current;
        mobileSidebarSwipeRef.current = null;
        const touch = event.changedTouches[0];
        if (
          !swipe ||
          !touch ||
          mobileSidebarOpen ||
          window.matchMedia("(min-width: 768px)").matches
        ) {
          return;
        }
        const rtl = document.documentElement.getAttribute("dir") === "rtl";
        const horizontal = rtl ? swipe.startX - touch.clientX : touch.clientX - swipe.startX;
        const vertical = Math.abs(touch.clientY - swipe.startY);
        if (horizontal >= MOBILE_SIDEBAR_SWIPE_DISTANCE_PX && horizontal > vertical * 1.25) {
          setMobileSidebarOpen(true);
        }
      }}
      onTouchCancelCapture={() => {
        mobileSidebarSwipeRef.current = null;
      }}
    >
      <ComputerUpdateProgress
        onCompleted={() => {
          if (active) void refreshThread(active.id);
        }}
      />
      {bootstrapMe !== undefined ? (
        <HostComputerPrompt initialMe={bootstrapMe ?? undefined} onMeUpdated={setBootstrapMe} />
      ) : null}
      <button
        type="button"
        aria-label={t`Close navigation`}
        aria-hidden={mobileSidebarOpen ? undefined : true}
        inert={mobileSidebarOpen ? undefined : true}
        tabIndex={mobileSidebarOpen ? undefined : -1}
        onClick={() => setMobileSidebarOpen(false)}
        className={`absolute inset-y-0 end-0 start-[min(calc(100%-48px),316px)] z-30 bg-overlay transition-opacity duration-150 ease-out motion-reduce:transition-none md:hidden ${
          mobileSidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <Sidebar
        collapsible={isMobileSidebar ? "none" : "icon"}
        side={document.documentElement.dir === "rtl" ? "right" : "left"}
        data-testid="bots-sidebar"
        data-space-switch="sidebar"
        inert={isMobileSidebar && !mobileSidebarOpen ? true : undefined}
        aria-hidden={isMobileSidebar && !mobileSidebarOpen ? true : undefined}
        data-bots-sidebar-density={botsSidebarDensity}
        data-collapsed={botsSidebarCollapsed ? "true" : "false"}
        className={
          isMobileSidebar
            ? `absolute inset-y-0 start-0 z-40 flex w-[calc(100%-48px)] max-w-[316px] shrink-0 flex-col border-e border-sidebar-border bg-sidebar transition-transform duration-200 ease-out motion-reduce:transition-none ${mobileSidebarOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full"}`
            : "h-full overflow-hidden border-sidebar-border"
        }
      >
        <SidebarHeader
          mini={miniSidebar}
          activityMode={activityMode}
          toggleActivityMode={() => {
            if (miniSidebar) setBotsSidebarCollapsedPref(false);
            toggleActivityMode();
          }}
          setBotsSidebarCollapsedPref={setBotsSidebarCollapsedPref}
          bots={bots}
          setMobileSidebarOpen={setMobileSidebarOpen}
          setPanel={setPanel}
          navigate={navigate}
          setNewSpaceOpen={setNewSpaceOpen}
          setPickerInfoTopic={setPickerInfoTopic}
        />
        {miniSidebar ? (
          <IconTooltip label={t`Search`}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`Search`}
              className="mx-auto mb-3"
              onClick={() => {
                setBotsSidebarCollapsedPref(false);
                requestAnimationFrame(() =>
                  document.querySelector<HTMLInputElement>('input[name="sidebar-search"]')?.focus(),
                );
              }}
            >
              <Search size={16} aria-hidden="true" />
            </Button>
          </IconTooltip>
        ) : (
          <InputGroup
            data-testid="sidebar-search"
            className="mx-2.5 mb-3 w-auto rounded-xl bg-card dark:bg-input border border-border text-muted-foreground focus-within:border-ring"
          >
            <InputGroupAddon>
              <Search size={16} strokeWidth={1.8} aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              value={activityMode ? activityFilters.query : query}
              onChange={(e) => {
                if (activityMode) setActivityFilters({ ...activityFilters, query: e.target.value });
                else setQuery(e.target.value);
              }}
              onKeyDown={(event) => {
                if (activityMode && event.key === "Escape") {
                  setActivityFilters({ ...activityFilters, query: "" });
                }
              }}
              placeholder={activityMode ? t`Search runs` : t`Search`}
              aria-label={activityMode ? t`Search runs` : t`Search`}
              autoComplete="off"
              name="sidebar-search"
            />
            {activityMode ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-sm"
                  aria-label={t`Filters`}
                  aria-expanded={activityFiltersExpanded}
                  aria-controls={activityFiltersId}
                  onClick={() => setActivityFiltersExpanded((expanded) => !expanded)}
                  className="relative rounded-lg"
                >
                  <SlidersHorizontal size={16} aria-hidden="true" />
                  {activityFilterCount > 0 ? (
                    <span
                      data-testid="activity-filter-indicator"
                      aria-hidden="true"
                      className="absolute end-1 top-1 size-1.5 rounded-full bg-primary"
                    />
                  ) : null}
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
        )}
        <div className="rk-scroll scroll-fade-y scroll-fade-12 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2.5">
          {showSpaceSearch && !miniSidebar ? (
            <SpaceSearchResults
              hits={searchHits}
              loading={searchLoading}
              onSelect={(hit) => void jumpToSearchHit(hit)}
            />
          ) : (
            <>
              {activityMode && !miniSidebar ? (
                <ActivityList
                  filters={activityFilters}
                  onFiltersChange={setActivityFilters}
                  filtersExpanded={activityFiltersExpanded}
                  filtersId={activityFiltersId}
                  onOpenRun={(run) => {
                    setMobileSidebarOpen(false);
                    if (run.groupId) navigate(`/app/g/${run.groupId}`);
                    else navigate(`/app/${run.botId}`);
                  }}
                />
              ) : null}
              <SidebarRoster
                mini={miniSidebar}
                sidebarGroups={sidebarGroups}
                collapsedSidebarSections={collapsedSidebarSections}
                collapsedRosterParents={collapsedRosterParents}
                bootstrapMe={bootstrapMe}
                botSections={botSections}
                spaces={spaces}
                rosterDropKey={rosterDropKey}
                setRosterDropKey={setRosterDropKey}
                rosterDropAction={rosterDropAction}
                applyRosterDrop={applyRosterDrop}
                openSpaceChat={openSpaceChat}
                spaceMenuAnchor={spaceMenuAnchor}
                setSpaceMenu={setSpaceMenu}
                setRenameSectionTarget={setRenameSectionTarget}
                setDeleteSectionTarget={setDeleteSectionTarget}
                toggleSidebarSection={toggleSidebarSection}
                inGroup={inGroup}
                active={active}
                activeGroup={activeGroup}
                botsSidebarDensity={botsSidebarDensity}
                dismissedRunErrorIds={dismissedRunErrorIds}
                displayedRunError={displayedRunError}
                draggedBotId={draggedBotId}
                setDraggedBotId={setDraggedBotId}
                toggleRosterParent={toggleRosterParent}
                botMenu={botMenu}
                setBotMenu={setBotMenu}
                reorderRosterBot={reorderRosterBot}
                activeSnapshot={activeSnapshot}
                botMenuContent={botMenuContent}
              />
            </>
          )}
          <div className={miniSidebar ? "hidden" : "contents"}>
            <ArchivedChats
              archivedBots={archivedBots}
              archivedGroups={archivedGroups}
              showSpaceSearch={showSpaceSearch}
              rpc={rpc}
              refreshBots={refreshBots}
              setDeleteTarget={setDeleteTarget}
              setDeleteGroupTarget={setDeleteGroupTarget}
            />
          </div>
        </div>
        <div className={miniSidebar ? "hidden" : "contents"}>
          <PasskeyOffer />
        </div>
        <SidebarFooter
          mini={miniSidebar}
          logos={footerLogos}
          name={userName}
          initials={initials}
          image={session.data?.user.image}
          email={session.data?.user.email}
          open={menuOpen}
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (!open) setLogOutError(null);
          }}
          onIntegrations={() => {
            setMenuOpen(false);
            setPluginsOpen(true);
          }}
          onBoard={
            bootstrapMe?.ticketBoardEnabled
              ? () => {
                  setMenuOpen(false);
                  setMobileSidebarOpen(false);
                  navigate("/app/board");
                }
              : undefined
          }
          onArtifacts={() => {
            setMenuOpen(false);
            setMobileSidebarOpen(false);
            navigate("/app/artifacts");
          }}
          onSettings={() => {
            setMenuOpen(false);
            openSettings("general");
          }}
          onUsage={() => {
            setMenuOpen(false);
            openSettings("usage");
          }}
          onLogOut={() => {
            setLogOutError(null);
            void logOut();
          }}
          signingOut={signingOut}
          logOutError={logOutError}
        />
      </Sidebar>

      {/* Keep the composer's z-index inside the chat so phone overlays like the side panel cover it. */}
      <main
        data-space-switch="main"
        aria-hidden={mobileSidebarOpen || undefined}
        inert={mobileSidebarOpen}
        className="isolate flex min-w-0 flex-1 flex-col bg-background"
      >
        {/* Inside main so the composer and its menus stay above it. */}
        {!mobileSidebarOpen ? (
          <div
            data-testid="mobile-sidebar-swipe-edge"
            aria-hidden="true"
            className="absolute bottom-20 start-0 top-16 z-20 w-8 touch-none md:hidden"
          />
        ) : null}
        <div className="app-drag flex items-center justify-between border-b border-sidebar-border px-3 py-[17px] md:px-[22px]">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              aria-label={t`Open navigation`}
              onClick={() => setMobileSidebarOpen(true)}
              className="app-no-drag grid h-8 w-8 shrink-0 place-items-center rounded-lg text-foreground/75 hover:bg-accent md:hidden"
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
                <span className="block truncate text-[16px] font-medium text-foreground" dir="auto">
                  {inGroup
                    ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`)
                    : (active?.name ?? t`Select a bot`)}
                </span>
              </span>
            </button>
          </div>
          <div className="flex items-center gap-1">
            {bootstrapMe?.phoneCallsEnabled && !inGroup && active ? (
              <IconTooltip label={call?.botId === active.id ? t`Open call` : t`Call`}>
                <button
                  type="button"
                  data-testid="call-button"
                  aria-label={call?.botId === active.id ? t`Open call` : t`Call`}
                  onClick={() => {
                    if (call?.botId === active.id) {
                      setCallMinimized(false);
                      return;
                    }
                    callBot(active);
                  }}
                  data-active={call?.botId === active.id ? "" : undefined}
                  className="app-no-drag grid h-[30px] w-[34px] place-items-center rounded-[9px] hover:bg-accent data-active:bg-accent"
                >
                  <Phone size={17} strokeWidth={1.6} className="text-foreground/75" />
                </button>
              </IconTooltip>
            ) : null}
            {!inGroup && active ? (
              <IconTooltip label={t`Agent computer`}>
                <button
                  type="button"
                  aria-label={t`Agent computer`}
                  aria-pressed={panel === "computer"}
                  onClick={() => {
                    const next = panel === "computer" ? null : "computer";
                    setPanel(next);
                    if (next === "computer" && active) {
                      // Refresh run/computer so Take control isn't stuck on a stale busyBotName.
                      void refreshThread(active.id).catch(() => undefined);
                    }
                  }}
                  data-active={panel === "computer" ? "" : undefined}
                  className="app-no-drag grid h-[30px] w-[34px] place-items-center rounded-[9px] hover:bg-accent data-active:bg-accent"
                >
                  <Monitor size={18} strokeWidth={1.6} className="text-foreground/75" />
                </button>
              </IconTooltip>
            ) : null}
          </div>
        </div>
        <CallReturnBar />
        {!active && !activeGroup && initialBotsLoaded ? (
          <div className="grid flex-1 place-items-center">
            <Button onClick={() => setPanel("create")}>
              <Plus size={16} aria-hidden="true" />
              <Trans>Create new Bot</Trans>
            </Button>
          </div>
        ) : (
          <Transcript
            key={activeSnapshot?.threadId}
            scrollRef={messageScroll}
            scrollRequest={scrollRequest}
            onScrollRequestHandled={clearScrollRequest}
            artifactTarget={transcriptArtifactTarget}
            transcript={transcript}
            showToolActivity={showToolActivity}
            olderCursor={activeSnapshot?.olderCursor ?? null}
            loadingOlder={loadingOlder}
            answerableAskIds={answerableAskIds}
            dismissableAskIds={dismissableAskIds}
            running={transcriptRunning}
            workingBots={workingBots}
            onCallBack={
              bootstrapMe?.phoneCallsEnabled && !inGroup && active
                ? () => callBot(active)
                : undefined
            }
            onLoadOlder={loadOlder}
            onOpenBot={openBot}
            onAnswer={answerMessage}
            onReply={(message) => {
              setReplyTarget(message);
              setReplyQuote(null);
            }}
            onQuote={(message, quote) => {
              setReplyTarget(message);
              setReplyQuote(quote);
            }}
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
            onOpenComputer={onOpenComputer}
          />
        )}
        {recordingSkill ? (
          <div className="px-6 pb-2 text-center text-[13px] text-destructive">
            <Trans>Teaching in progress. Stop teaching before sending a new message.</Trans>
          </div>
        ) : null}
        {active || activeGroup ? (
          <Composer
            key={inGroup ? `group:${groupId}` : `bot:${active?.id}`}
            draftKey={inGroup ? `group:${groupId}` : `bot:${active?.id}`}
            enterToSend={enterToSend}
            activeName={inGroup ? (activeGroup?.name ?? activeSnapshot?.groupName) : active?.name}
            running={composerRunning}
            disabled={Boolean(recordingSkill)}
            pendingAttachments={activePendingAttachments}
            attachmentNotice={attachmentNotice}
            sendError={sendError}
            onOpenModels={() => openSettings("models")}
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
            phoneCallsEnabled={bootstrapMe?.phoneCallsEnabled === true}
            dictationTranscribe={voiceStatus ? Boolean(voiceStatus.transcribe) : undefined}
            artifactTarget={transcriptArtifactTarget}
            replyTarget={activeReplyTarget}
            replyQuote={activeReplyQuote}
            replyTargetName={replyTargetName}
            onClearReply={clearReply}
            mentionTargets={composerMentionTargets}
            agentSkills={agentSkills}
            onSlashOpen={refreshAgentSkills}
            onSlashAction={(action) => {
              if (action === "chat-settings") {
                setPanel(inGroup ? "group-settings" : "settings");
                return;
              }
              if (action === "settings-general") {
                openSettings("general");
                return;
              }
              if (action === "settings-usage") {
                openSettings("usage");
              }
            }}
          />
        ) : null}
      </main>

      <CallCard onSettings={() => openSettings("voice")} />
      <IncomingCall
        bots={bootstrapMe?.phoneCallsEnabled ? bots : []}
        transcribe={voiceStatus ? Boolean(voiceStatus.transcribe) : undefined}
        onAnswered={(botId) => navigate(`/app/${botId}`)}
      />

      <ResizableSidePanel
        open={Boolean(panel && (active || activeGroup || panel === "create"))}
        panel={panel ?? "closed"}
      >
        {panel && (active || activeGroup || panel === "create") ? (
          <div className="rk-scroll h-full w-full overflow-y-auto px-5 py-[17px]">
            {panel !== "routine" &&
            panel !== "create" &&
            panel !== "create-group" &&
            panel !== "group-settings" ? (
              <div className="mb-4 flex items-center justify-between">
                <span className="text-[13.5px] text-muted-foreground">
                  {panel === "settings" ? (
                    <Trans>Settings</Trans>
                  ) : active ? (
                    (computer?.state ?? active.status)
                  ) : (
                    <Trans>Group</Trans>
                  )}
                </span>
                <div className="flex gap-1">
                  {active &&
                  panel === "computer" &&
                  !computerOpen &&
                  computerPanelNeedsMaintenance(computer?.state, booting) ? (
                    <ComputerMaintenanceActions
                      botId={active.id}
                      computer={computer}
                      onChanged={async () => {
                        await refreshThread(active.id);
                      }}
                    />
                  ) : null}
                  {active ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={panel === "settings" ? t`Show computer` : t`Show settings`}
                      onClick={() => setPanel(panel === "settings" ? "computer" : "settings")}
                      className={panel === "settings" ? "text-foreground" : "text-muted-foreground"}
                    >
                      <Settings size={16} strokeWidth={1.7} />
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t`Close panel`}
                    onClick={() => setPanel(null)}
                  >
                    <X size={16} strokeWidth={1.8} />
                  </Button>
                </div>
              </div>
            ) : null}
            {panel === "computer" && active ? (
              <ComputerPanel
                bot={active}
                computer={computer}
                computerOpen={computerOpen}
                embeddedScreenUrl={embeddedScreenUrl}
                screenFrameRef={setScreenFrame}
                computerScreenError={computerScreenError}
                computerBooting={computerBooting}
                booting={booting}
                showingRecoveryHint={showingRecoveryHint}
                showComputerRecoveryHint={showComputerRecoveryHint}
                sandboxProvider={bootstrapMe?.sandboxProvider}
                onRecovered={(sandboxProvider) => {
                  setBootstrapMe((prev) => (prev ? { ...prev, sandboxProvider } : prev));
                  holdComputerRecovery();
                }}
                onRecoveryDismissed={releaseComputerRecovery}
                onOpenComputerSettings={
                  bootstrapMe?.isDeploymentOwner === true
                    ? () => openSettings("computer")
                    : undefined
                }
                onOpen={() => void openComputer()}
                routines={activeRoutines}
                runningRoutineId={
                  snapshot?.run && isActive(snapshot.run.status)
                    ? (snapshot.run.routineId ?? undefined)
                    : undefined
                }
                onCreateRoutine={() => startRoutine()}
                onEditRoutine={startRoutine}
                onStopRun={() => void stopRun()}
              />
            ) : null}
            {panel === "create-group" ? (
              <CreateGroupForm
                bots={bots}
                onCancel={() => setPanel(null)}
                onCreate={(input) => createGroup(input)}
                onOpenBot={(botId) => {
                  setPanel(null);
                  openBot(botId);
                }}
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
                  void Promise.all([refreshBots(), refreshGroupThread(activeGroup.id)]).catch(
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
                onClose={() => setPanel(null)}
                onOpenBot={openBot}
                covered={computerOpen}
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
                memoryProviderConfigured={memoryProviderConfig != null}
                onSkillsChange={setAgentSkills}
                onSave={async ({ computerMode, ...patch }) => {
                  if (computerMode !== undefined && computerMode !== active.computerMode) {
                    await rpc.bots.setComputer({
                      botId: active.id,
                      mode: computerMode,
                    });
                  }
                  const updated = await rpc.bots.update({ botId: active.id, ...patch });
                  setBots((current) =>
                    current.map((bot) => (bot.id === updated.id ? updated : bot)),
                  );
                  // Persistence succeeded; a failed navigation refresh must not undo the tool edit.
                  await refreshBots().catch(() => undefined);
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
              />
            ) : null}
            {panel === "routine" && routineEditorProps ? (
              <RoutineEditor {...routineEditorProps} />
            ) : null}
          </div>
        ) : null}
      </ResizableSidePanel>

      <Suspense fallback={null}>
        {spaceMenu ? (
          <DropdownMenu
            open
            onOpenChange={(open) => {
              if (!open) closeSpaceMenu();
            }}
          >
            {/* Invisible anchor at the pointer position, mirroring the bot menu. */}
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="fixed size-0 p-0 opacity-0"
                  style={{ left: spaceMenu.position.x, top: spaceMenu.position.y }}
                />
              }
            />
            <DropdownMenuContent
              aria-label={t`Actions for space`}
              align="start"
              sideOffset={0}
              className="w-[220px]"
            >
              {spaceMenuTarget ? (
                <DropdownMenuItem
                  onClick={() => {
                    setSpaceMenu(null);
                    openSpaceSettings(spaceMenuTarget.id);
                  }}
                >
                  <Settings />
                  {t`Settings`}
                </DropdownMenuItem>
              ) : null}
              {spaceMenuTarget?.canRename ? (
                <DropdownMenuItem
                  onClick={() => {
                    setRenameSpaceTarget(spaceMenuTarget);
                    setSpaceMenu(null);
                  }}
                >
                  <Pencil />
                  {t`Rename space`}
                </DropdownMenuItem>
              ) : null}
              {spaceMenuTarget?.canDelete ? (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    setDeleteSpaceTarget(spaceMenuTarget);
                    setSpaceMenu(null);
                  }}
                >
                  <Trash2 />
                  {t`Delete space`}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
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

        {renameSpaceTarget ? (
          <RenameSpaceDialog
            space={renameSpaceTarget}
            onCancel={() => setRenameSpaceTarget(null)}
            onConfirm={async (name) => {
              const spaceId = renameSpaceTarget.id;
              await commitSpaceRename({
                rename: async () => {
                  await rpc.spaces.rename({ spaceId, name });
                },
                apply: () => {
                  setSpaces((current) =>
                    current.map((space) => (space.id === spaceId ? { ...space, name } : space)),
                  );
                },
                refresh: () => refreshBots(),
              });
              setRenameSpaceTarget(null);
            }}
          />
        ) : null}

        {deleteSpaceTarget ? (
          <DeleteItemDialog
            item={deleteSpaceTarget}
            noun="space"
            description={
              <Trans>Only empty spaces can be deleted. Delete its bots and groups first.</Trans>
            }
            onCancel={() => setDeleteSpaceTarget(null)}
            onConfirm={async () => {
              const targetId = deleteSpaceTarget.id;
              const result = await rpc.spaces.remove({ spaceId: targetId });
              if (!alive.current) return;
              setDeleteSpaceTarget(null);
              setPanel(null);
              const effectiveSpaceId = selectedSpaceId() ?? bootstrapMe?.spaceId;
              if (effectiveSpaceId === targetId) {
                // The auth boundary changed, so reload like a space switch.
                if (selectSpace(result.activeSpaceId)) {
                  window.location.assign("/app");
                  return;
                }
              }
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

        {renameSectionTarget ? (
          <RenameBotSectionDialog
            section={renameSectionTarget.section}
            onCancel={() => setRenameSectionTarget(null)}
            onConfirm={async (name) => {
              await rpc.botSections.update(
                {
                  sectionId: renameSectionTarget.section.id,
                  name,
                },
                { context: { spaceId: renameSectionTarget.spaceId } },
              );
              setRenameSectionTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {deleteSectionTarget ? (
          <DeleteItemDialog
            item={deleteSectionTarget.section}
            noun="section"
            description={<Trans>Its bots and groups are kept and leave the section.</Trans>}
            onCancel={() => setDeleteSectionTarget(null)}
            onConfirm={async () => {
              await rpc.botSections.remove(
                { sectionId: deleteSectionTarget.section.id },
                { context: { spaceId: deleteSectionTarget.spaceId } },
              );
              setDeleteSectionTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        <CommandPalette
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
          bots={bots}
          onSelectBot={(id) => {
            setMobileSidebarOpen(false);
            navigate(`/app/${id}`);
          }}
        />

        {newSpaceOpen ? (
          <NewSpaceDialog
            onCancel={() => setNewSpaceOpen(false)}
            onConfirm={async (name) => {
              const space = await rpc.spaces.create({ name });
              if (!alive.current) return;
              if (!selectSpace(space.id)) {
                setNewSpaceOpen(false);
                await refreshBots();
                return;
              }
              window.location.assign("/onboarding");
            }}
          />
        ) : null}

        {pickerInfoTopic ? (
          <PickerInfoDialog topic={pickerInfoTopic} onClose={() => setPickerInfoTopic(null)} />
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

        {deleteRoutineDialogProps ? <DeleteItemDialog {...deleteRoutineDialogProps} /> : null}

        {pluginsOpen ? (
          <PluginsOverlay
            onConnectedAppsChange={setFooterLogos}
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
        {settingsOpen && (settingsSpaceId === null || settingsSpace) ? (
          <SettingsOverlay
            space={settingsSpace}
            spaces={spaces}
            currentSpaceId={currentSpaceId}
            onSpaceChange={setSettingsSpaceId}
            name={userName}
            email={session.data?.user.email}
            usage={usage}
            onUsageOpen={refreshUsage}
            initialSection={settingsSection}
            avatarStyle={bootstrapMe?.avatarStyle ?? "organic"}
            isDeploymentOwner={bootstrapMe?.isDeploymentOwner === true}
            billingEnabled={bootstrapMe?.billingEnabled === true}
            sandboxProvider={bootstrapMe?.sandboxProvider}
            onSandboxProviderChange={(sandboxProvider) =>
              setBootstrapMe((prev) => (prev ? { ...prev, sandboxProvider } : prev))
            }
            messagingEnabled={messagingSurfaceEnabled}
            onOpenMessaging={() => {
              setSettingsOpen(false);
              setMessagingSettingsOpen(true);
            }}
            onAvatarStyleChange={async (avatarStyle) => {
              const nextMe = await rpc.preferences.update({ avatarStyle });
              // Merge only the saved field: a concurrent save's response must not be undone.
              setBootstrapMe((prev) =>
                prev ? { ...prev, avatarStyle: nextMe.avatarStyle } : nextMe,
              );
            }}
            timezone={bootstrapMe?.timezone ?? null}
            onTimezoneChange={async (timezone) => {
              const nextMe = await rpc.preferences.update({ timezone });
              setBootstrapMe((prev) => (prev ? { ...prev, timezone: nextMe.timezone } : nextMe));
            }}
            memoryConfig={memoryProviderConfig}
            onMemoryConfigChange={(config) => {
              memoryProviderConfigRevision.current += 1;
              setMemoryProviderConfig(config);
            }}
            onVoiceStatusMaybeChanged={async () => {
              try {
                setVoiceStatus(
                  await Promise.race([rpc.voice.status(), voiceStatusRefreshTimeout()]),
                );
              } catch {
                // Prefer reopening Voice settings over starting a call with stale readiness.
                setVoiceStatus(null);
              }
            }}
            onClose={() => {
              setSettingsOpen(false);
              setSettingsSection("general");
            }}
          />
        ) : null}
        {peerConversation && active ? (
          <PeerMessagesOverlay
            botId={active.id}
            botName={active.name}
            botColor={active.color}
            peerBotId={peerConversation.peerBotId}
            peerBotName={peerConversation.peerBotName}
            peerBotColor={
              resolveTranscriptBot(peerConversation.peerBotId)?.color ?? FALLBACK_BOT_COLOR
            }
            onClose={() => setPeerConversation(null)}
          />
        ) : null}
      </Suspense>

      {computerOpen && computerBot ? (
        <ComputerOverlay
          bot={computerBot}
          computer={computer}
          computerViewport={computerViewport}
          recordingSkill={recordingSkill}
          teachBusy={teachBusy}
          hasControl={hasControl}
          composerRunning={composerRunning}
          sending={sending}
          booting={booting}
          runStatus={snapshot?.run?.status}
          sendError={sendError}
          embeddedScreenUrl={embeddedScreenUrl}
          screenFrameRef={setScreenFrame}
          computerScreenError={computerScreenError}
          computerBooting={computerBooting}
          onStopTeaching={stopTeaching}
          onStopRun={() => void stopRun()}
          onRelease={releaseComputer}
          onTakeControl={() => void openComputer(computerBot.id, true)}
          onRefreshTeaching={refreshActiveTeaching}
          onRefreshComputer={async () => {
            await refreshComputerFor(computerBot.id);
          }}
          onClose={() => setComputerOpen(false)}
        />
      ) : null}
    </BotsSidebarLayout>
  );

  return (
    <AvatarStyleProvider value={bootstrapMe?.avatarStyle ?? "organic"}>{shell}</AvatarStyleProvider>
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
