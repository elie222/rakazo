import { Trans } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { DEFAULT_NEW_BOT_AVATAR_SET, hasLab } from "@rakazo/contracts";
import { chatWoke } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import { Button } from "@rakazo/ui-web";
import { useIsMobile } from "@rakazo/ui-web/hooks/use-mobile";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { CallCard } from "../components/call/CallCard";
import { IncomingCall } from "../components/call/IncomingCall";
import { ComputerUpdateProgress } from "../components/computers/ComputerUpdateProgress";
import { PageLoading } from "../components/PageLoading";
import { PageViewHost } from "../components/pages/PageViewHost";
import { authClient } from "../lib/auth/auth";
import { peekBootstrapSeed } from "../lib/bootstrap";
import { toolActivityPreference } from "../lib/chat/tool-activity-preference";
import { composerEnterToSendPreference } from "../lib/composer/composer-enter-to-send-pref";
import { PagesProvider, usePagesForChat } from "../lib/pages/pages";
import { desktopBridge } from "../lib/platform/desktop";
import { usePreloadRecoveryState } from "../lib/platform/preload-recovery";
import { botsSidebarDensityPreference } from "../lib/preferences/bots-sidebar-density-pref";
import { chatPreferencesQuery, useChatPreferences } from "../lib/preferences/chat-preferences";
import {
  lastChatKey,
  lastChatOf,
  queryClient,
  spaceQueries,
  spaceSeedKey,
} from "../lib/query/query";
import type { RpcClient } from "../lib/query/rpc";
import { createSpaceRpc, selectedSpaceId } from "../lib/query/rpc";
import { SpaceRpcProvider } from "../lib/query/space-rpc";
import { InboundOriginProvider } from "../lib/routines/inbound-url";
import type { CreateBotDialogInput } from "./shell/bots/create-bot-dialog";
import { useTeaching } from "./shell/bots/use-teaching";
import { ChatColumn } from "./shell/chat/chat-column";
import { useChatMenu } from "./shell/chat/chat-context-menu";
import { ChatHeader } from "./shell/chat/chat-header";
import { Transcript } from "./shell/chat/transcript";
import { useChatRead } from "./shell/chat/use-chat-read";
import { useMessageActions } from "./shell/chat/use-message-actions";
import { useMessageJump } from "./shell/chat/use-message-jump";
import { useReadAloud } from "./shell/chat/use-read-aloud";
import { useThreadState } from "./shell/chat/use-thread-state";
import { useThreadSync } from "./shell/chat/use-thread-sync";
import { useTranscriptView } from "./shell/chat/use-transcript-view";
import { openAlertChat, openSettingsInChat } from "./shell/chat-panels";
import { ChatComposerArea } from "./shell/composer/chat-composer-area";
import { useComposerActions } from "./shell/composer/use-composer-actions";
import { useComposerMentions } from "./shell/composer/use-composer-mentions";
import { useComposerModelShortcuts } from "./shell/composer/use-composer-model-shortcuts";
import { ComputerOverlay } from "./shell/computers/computer-overlay";
import { ComputerPanel } from "./shell/computers/computer-panel";
import { useComputerControls, useComputerState } from "./shell/computers/use-computer";
import { HostComputerPrompt } from "./shell/host-computer-prompt";
import { KeyboardShortcutsDialog } from "./shell/keyboard-shortcuts-dialog";
import { ShellDialogs, useShellDialogs } from "./shell/shell-dialogs";
import { AppOverlays, SettingsOverlays } from "./shell/shell-overlays";
import { isApplePlatform } from "./shell/shell-shortcuts";
import { ShellSidePanel } from "./shell/side-panel";
import { ArchivedChats } from "./shell/sidebar/archived-chats";
import { ShellSidebar } from "./shell/sidebar/shell-sidebar";
import { BotsSidebarLayout } from "./shell/sidebar/sidebar-layout";
import { SidebarRoster } from "./shell/sidebar/sidebar-roster";
import { SnoozedChats } from "./shell/sidebar/snoozed-chats";
import { useChatSnooze } from "./shell/sidebar/use-chat-snooze";
import { useMobileSidebar } from "./shell/sidebar/use-mobile-sidebar";
import { useSidebarExpansion } from "./shell/sidebar/use-sidebar-expansion";
import { useSidebarSearch } from "./shell/sidebar/use-sidebar-search";
import { useSidebarView } from "./shell/sidebar/use-sidebar-view";
import { useSnoozeClock } from "./shell/sidebar/use-snooze-clock";
import { useRosterDrop, useSpaceBootstrap, useSpaceRoster } from "./shell/sidebar/use-space-roster";
import { useSpaceEpoch } from "./shell/space-switch";
import { TimezonePrompt, withSavedTimezone } from "./shell/timezone-prompt";
import { useChatThreads } from "./shell/topics/use-chat-threads";
import { useActiveChat } from "./shell/use-active-chat";
import { useBotCall } from "./shell/use-bot-call";
import { useBrowserNotifications } from "./shell/use-browser-notifications";
import { usePaletteActions } from "./shell/use-palette-actions";
import { useReportedUiLocale } from "./shell/use-reported-ui-locale";
import { useRightPanel, useRightPanelRestore } from "./shell/use-right-panel";
import { useRoutineEditor } from "./shell/use-routine-editor";
import { useRoutineList } from "./shell/use-routine-list";
import { useShellNavigation } from "./shell/use-shell-navigation";
import { useShellReadyMarks } from "./shell/use-shell-ready-marks";
import { useShellSettings } from "./shell/use-shell-settings";
import { useShellShortcutActions } from "./shell/use-shell-shortcut-actions";
import { useShellStatus } from "./shell/use-shell-status";
import { useSpaceActions } from "./shell/use-space-actions";
import { useOpenSpaceChat } from "./shell/use-space-switch";

export function ShellPage() {
  // A new key per space switch, so nothing from the previous space survives it.
  const spaceEpoch = useSpaceEpoch();
  return <SpaceShell key={spaceEpoch} />;
}

function SpaceShell() {
  const { botId, groupId } = useParams();
  const [shellSpaceId] = useState(selectedSpaceId);
  const [rpc] = useState(() => createSpaceRpc(shellSpaceId));
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  // Held from the first render, so Cmd/Ctrl+N works before the sidebar has data.
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  // A revisited space, or the shell reopened from another page, starts from what it showed
  // last time while its fresh bootstrap loads.
  const [{ seed, startChat }] = useState(() => {
    const primed = peekBootstrapSeed(botId);
    if (primed) return { seed: primed, startChat: undefined };
    const cached = queryClient.getQueryData(spaceSeedKey(userId ?? null, shellSpaceId));
    const lastChat = queryClient.getQueryData(lastChatKey(userId ?? null, shellSpaceId));
    return { seed: cached, startChat: botId || groupId ? undefined : lastChatOf(cached, lastChat) };
  });
  const {
    navigate,
    navigationRevision,
    overlayRevision,
    alive,
    searchParams,
    setSearchParams,
    searchParamsRef,
    redirectKeepingOverlay,
    overlay,
    setOverlay,
  } = useShellNavigation();
  const queries = spaceQueries(userId ?? null, shellSpaceId);
  const roster = useSpaceRoster({ rpc, seed, navigate, redirectKeepingOverlay });
  const {
    groups,
    setGroups,
    groupsRef,
    bots,
    setBots,
    botsRef,
    botSections,
    spaces,
    setSpaces,
    firstBotDue,
    archivedBots,
    archivedGroups,
    initialBotsLoaded,
    initialLoadFailed,
    bootstrapMe,
    setBootstrapMe,
    refreshBots,
  } = roster;
  const snoozeNow = useSnoozeClock([
    ...bots,
    ...groups,
    ...spaces.flatMap((space) => [...space.bots, ...space.groups]),
  ]);
  const snooze = useChatSnooze({
    rpc,
    openSpaceId: bootstrapMe?.spaceId,
    setBots,
    setGroups,
    setSpaces,
    refreshBots,
  });
  const { collapsedSidebarSections, toggleSidebarSection } = useSidebarExpansion(userId);
  const search = useSidebarSearch({ rpc, navigate });
  const { data: me } = useQuery({
    ...chatPreferencesQuery(queries, userId),
    placeholderData: bootstrapMe && bootstrapMe.userId === userId ? bootstrapMe : undefined,
  });
  const chatPreferences = useChatPreferences(me?.chatPreferences);
  const enterToSend = composerEnterToSendPreference.use();
  const showToolActivity = toolActivityPreference.use();
  const thread = useThreadState(chatPreferences.streamReplies);
  const { snapshot } = thread;
  const botsSidebarDensity = botsSidebarDensityPreference.use();
  const rightPanel = useRightPanel({ searchParams, setSearchParams });
  const { panel, setPanel, modelFocusRequest, setModelFocusRequest } = rightPanel;
  const [peerConversation, setPeerConversation] = usePreloadRecoveryState<{
    peerBotId: string;
    peerBotName: string;
  } | null>("peerConversation", null);
  const {
    agentSkills,
    refreshAgentSkills,
    messagingEnabled: messagingSurfaceEnabled,
    messagingProviders,
    memoryProviderConfig,
    voiceStatus,
  } = useShellStatus(queries, Boolean(session.data?.user));
  const { call, callBot, openCall } = useBotCall({
    phoneCallsEnabled: Boolean(bootstrapMe?.phoneCallsEnabled),
    voiceStatus,
    openVoiceSettings: () => openSettings("voice"),
  });
  const { mobileSidebarOpen, setMobileSidebarOpen, swipeHandlers } = useMobileSidebar();
  const isMobileSidebar = useIsMobile();
  const [panelCoversChat, setPanelCoversChat] = useState(false);
  const [panelOverlays, setPanelOverlays] = useState(false);
  const pages = usePagesForChat();
  const sidebar = useSidebarView({
    userId,
    isMobile: isMobileSidebar,
    bootstrapMe,
    spaces,
    bots,
    groups,
    botSections,
    searchQuery: search.query,
    now: snoozeNow,
  });

  const { inGroup, routeChat, active, activeGroup, activeBotId, activeGroupId, userBubble } =
    useActiveChat({ botId, groupId, startChat, bots, groups, now: snoozeNow });
  const selectBot = useCallback(
    (id: string) => {
      setMobileSidebarOpen(false);
      navigate(`/app/${id}`);
    },
    [navigate, setMobileSidebarOpen],
  );
  const computerState = useComputerState({ rpc, panel, activeId: active?.id, activeBotId });
  const { computerOpen, setComputerOpen, commitComputer } = computerState;
  useReportedUiLocale(rpc, bootstrapMe?.locale);
  const dialogs = useShellDialogs();
  const openSpaceChatRef = useRef<(spaceId: string, path: string) => void>(() => {});
  const rosterSignals = useSpaceBootstrap({
    roster,
    thread,
    commitComputer,
    userId,
    shellSpaceId,
    seed,
    startChat,
    botId,
    groupId,
    chat: groupId ? { groupId } : active ? { botId: active.id } : undefined,
    navigate,
    redirectKeepingOverlay,
    openSpaceChat: openSpaceChatRef,
  });
  const chatPanels = { rightPanel, userId, spaceId: bootstrapMe?.spaceId, navigate };
  const { notifyBrowserForEvent, flushPendingBrowserNotifications } = useBrowserNotifications(
    bots,
    botsRef,
    {
      rpc,
      activeBotId,
      activeGroupId,
      openChat: (alert) => {
        setMobileSidebarOpen(false);
        openAlertChat(alert, chatPanels);
      },
      meId: userId,
      groupsRef,
      roster: rosterSignals,
    },
  );
  const { speakingMessageId, speakMessage, callHoldsSpeaker } = useReadAloud({
    active,
    snapshot,
    callBotId: call?.botId,
    activeBotId,
    openVoiceSettings: () => openSettings("voice"),
  });
  const read = useChatRead({ rpc, active, groupId, activeGroup, setBots, setGroups });
  // A chat that wakes while it is open is already seen: read it, which ends the snooze.
  const openChatWoke = active
    ? chatWoke(active, snoozeNow)
    : activeGroup
      ? chatWoke(activeGroup, snoozeNow)
      : false;
  useEffect(() => {
    if (!openChatWoke) return;
    if (groupId) read.markGroupReadOnReply(groupId);
    else if (active) read.markBotReadIfVisible(active.id);
  }, [openChatWoke]);
  const {
    refreshThread,
    refreshGroupThread,
    refreshThreadRef,
    refreshGroupThreadRef,
    refreshActiveThread,
    loadOlder,
    loadingOlder,
    terminalRunReceipts,
  } = useThreadSync({
    rpc,
    queries,
    thread,
    computerState,
    seed,
    active,
    inGroup,
    groupId,
    activeGroup,
    activeBotId,
    activeGroupId,
    botsRef,
    searchParamsRef,
    refreshBots,
    notifyBrowserForEvent,
    markBotReadIfVisible: read.markBotReadIfVisible,
    markGroupReadOnReply: read.markGroupReadOnReply,
    meId: userId,
  });
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
    inboundOrigin: bootstrapMe?.inboundOrigin,
    setBots,
    refreshThread,
    openGroup: (id) => navigate(`/app/g/${id}`),
    setPanel,
    messageProviders: messagingProviders,
  });
  // Until this visit's read lands, a bot shows the skills it had last time.
  const activeTaughtSkills = !active
    ? []
    : thread.taughtSkillsBotId === active.id
      ? thread.taughtSkills
      : (queryClient.getQueryData(queries.skills.list.queryKey({ input: { botId: active.id } })) ??
        []);
  const recordingSkill = activeTaughtSkills.find((skill) => skill.status === "recording") ?? null;
  const modelShortcuts = useComposerModelShortcuts({
    botId: inGroup ? undefined : active?.id,
    enabled: chatPreferences.composerModelPicker && !recordingSkill,
  });
  const {
    chatPanelOpen,
    toggleChatPanel,
    focusComposer,
    registerQuoteShortcut,
    shortcutsOpen,
    setShortcutsOpen,
    findOpen,
    setFindOpen,
    findInputRef,
  } = useShellShortcutActions({
    botId,
    groupId,
    active,
    activeGroup,
    bots,
    botSections,
    snoozeNow,
    navigate,
    selectBot,
    setCommandPaletteOpen: dialogs.setCommandPaletteOpen,
    setCreateMenuOpen,
    setOverlay,
    panel,
    setPanel,
    panelOverlays,
    computerOpen,
    isMobileSidebar,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    sidebarCollapsed: sidebar.collapsed,
    setSidebarCollapsed: sidebar.setCollapsedPref,
    openSidebarSearch: () => search.setSearchOpen(true),
    modelShortcuts,
    refreshThread,
  });
  const {
    settingsSpaceId,
    settingsSpace,
    openSettings,
    openSpaceSettings,
    openImportSetup,
    openAgentImport,
  } = useShellSettings({
    overlay,
    setOverlay,
    searchParams,
    setSearchParams,
    spaces,
    currentSpaceId: selectedSpaceId() ?? bootstrapMe?.spaceId ?? null,
    initialBotsLoaded,
    refreshActiveThread,
  });

  const openSpaceChat = useOpenSpaceChat({
    bootstrapSpaceId: bootstrapMe?.spaceId,
    userId,
    navigate,
    navigationRevision,
    overlayRevision,
    closeMobileSidebar: () => setMobileSidebarOpen(false),
    beginSpaceSwitch: roster.beginSpaceSwitch,
  });
  useLayoutEffect(() => {
    openSpaceChatRef.current = openSpaceChat;
  }, [openSpaceChat]);

  const view = useTranscriptView({
    snapshot,
    inGroup,
    groupId,
    active,
    activeGroup,
    bots,
    archivedBots,
    meId: userId,
  });
  const { activeSnapshot, transcript, composerRunning } = view;
  const { composerMentionTargets, footerLogos, setFooterLogos } = useComposerMentions({
    rpc,
    queries,
    bots,
    groups,
    inGroup,
    groupId,
    integrationsOpen: overlay?.kind === "integrations",
    initialBotsLoaded,
  });
  // Not while the shell is leaving: a roster with nothing anywhere is on its way to onboarding,
  // and a reopened group chat is on its way to that group.
  const showNewBotPrompt =
    initialBotsLoaded &&
    bots.length === 0 &&
    !activeGroup &&
    !routeChat?.groupId &&
    (groups.length > 0 ||
      archivedBots.length > 0 ||
      archivedGroups.length > 0 ||
      spaces.some((space) => space.hasContent) ||
      // Someone who has chatted before, in a new organization: nothing is on its way to them.
      !firstBotDue);
  const shellReady =
    initialBotsLoaded &&
    (inGroup
      ? Boolean(activeGroup && activeSnapshot)
      : bots.length === 0 || Boolean(active && activeSnapshot));

  useShellReadyMarks({
    botsLoaded: initialBotsLoaded,
    active,
    snapshotBotId: snapshot?.botId,
    ready: shellReady,
  });

  const { scrollRequest, clearScrollRequest, jumpToReplyMessage } = useMessageJump({
    rpc,
    queries,
    thread,
    commitComputer,
    transcript,
    active,
    inGroup,
    groupId,
    activeBotId,
    activeGroupId,
    searchParams,
    setSearchParams,
    setPanel,
    setPanelState: rightPanel.setPanelState,
    editRoutine,
    resetRoutineTarget,
  });
  const computerControls = useComputerControls({
    rpc,
    state: computerState,
    panel,
    active,
    bots,
    botsRef,
    activeBotId,
    activeGroupId,
    runStatus: snapshot?.run?.status,
    sandboxProvider: bootstrapMe?.sandboxProvider,
    refreshThread,
    refreshGroupThread: (id) => refreshGroupThreadRef.current(id),
    onUpgrade: () => openSettings("billing"),
    onSendError: (message) => composer.setSendError(message),
  });
  const { computerBot, openComputer } = computerControls;
  const composer = useComposerActions({
    rpc,
    pageSession: pages.session,
    activeId: active?.id,
    inGroup,
    groupId,
    activeBotId,
    activeGroupId,
    botsRef,
    bootstrapMe,
    activeSnapshot,
    navigate,
    refreshBots,
    refreshThreadRef,
    refreshGroupThreadRef,
    updateSnapshot: thread.updateSnapshot,
    terminalRunReceipts,
    computerRef: computerState.computerRef,
    commitComputer,
    clearReadBoundary: read.clearReadBoundary,
    flushPendingBrowserNotifications,
  });
  const { sending, sendError, stopRun } = composer;
  const routineList = useRoutineList({
    rpc,
    queries,
    thread,
    active,
    inGroup,
    activeBotId,
    refreshThread,
    startRoutine,
    stopRun,
    setSendError: composer.setSendError,
  });
  const openChatSettings = (kind: "bot" | "group", id: string) =>
    openSettingsInChat(kind, id, chatPanels);

  useRightPanelRestore({
    rightPanel,
    userId,
    spaceId: bootstrapMe?.spaceId,
    inGroup,
    panelTarget: inGroup ? activeGroup?.id : active?.id,
    activeId: active?.id,
    routines: thread.routines,
    routinesBotId: thread.routinesBotId,
    searchParams,
    editingRoutineId: editingRoutine?.id,
    restoreRoutine,
    leaveRoutine,
  });
  const rosterDrop = useRosterDrop({
    rpc,
    bots,
    reorderRosterBot: roster.reorderRosterBot,
    refreshBots,
    refreshGroupThread: (id) => refreshGroupThreadRef.current(id),
    activeGroupId,
    setSendError: composer.setSendError,
  });

  const openBot = useCallback((id: string) => navigate(`/app/${id}`), [navigate]);
  const { replyToMessage, quoteMessage, markMessageUnread } = useMessageActions({
    activeId: active?.id,
    groupId,
    setReplyTarget: composer.setReplyTarget,
    setReplyQuote: composer.setReplyQuote,
    focusComposer,
    quoteBlocked: computerOpen || mobileSidebarOpen || Boolean(isMobileSidebar && panel),
    markBotUnread: read.markBotUnread,
    markGroupUnreadFrom: read.markGroupUnreadFrom,
  });
  const { teachBusy, stopTeaching, refreshActiveTeaching } = useTeaching({
    rpc,
    queries,
    thread,
    activeBotId,
    refreshThreadRef,
    closeComputer: () => setComputerOpen(false),
  });

  const paletteActions = usePaletteActions({
    me: bootstrapMe,
    messagingEnabled: messagingSurfaceEnabled,
    onNewBot: () => dialogs.setCreateBotOpen(true),
    onNewGroup: () => setPanel("create-group"),
    onNewSpace: () => dialogs.setNewSpaceOpen(true),
    onShortcuts: () => setShortcutsOpen(true),
    setOverlay,
    openSettings,
  });
  const { renameSpace, removeSpace, leftSpace } = useSpaceActions({
    rpc,
    alive,
    setSpaces,
    refreshBots,
    bootstrapMe,
    closePanel: () => setPanel(null),
  });

  function openCreatedBot(bot: Bot) {
    roster.addCreatedBot(bot);
    navigate(`/app/${bot.id}`);
    setPanel(null);
  }

  async function createBot(input: CreateBotDialogInput, client: RpcClient) {
    const isFirstBot = botsRef.current.length === 0;
    const bot = await client.bots.create({ ...input, notifyOnFinish: true });
    openCreatedBot(bot);
    dialogs.setCreateBotOpen(false);
    await composer.startFocusPrompt(bot.id, isFirstBot);
    await bestEffort("refresh bots after creating one", refreshBots());
  }

  const chatMenu = useChatMenu({
    bots,
    groups,
    rpc,
    sections: botSections,
    spaceId: bootstrapMe?.spaceId,
    refreshBots,
    read,
    snooze,
    dialogs,
    openChatSettings,
    navigate,
  });
  // The callbacks a message needs, shared by the chat and the thread beside it.
  const messageContext = {
    onOpenBot: openBot,
    onOpenPeerMessages: setPeerConversation,
    peerBot: view.resolveBot,
    onBotChanged: refreshBots,
    onAddRoutine: addSkillRoutine,
    onOpenComputer: computerControls.onOpenComputer,
    onReleaseComputer: computerControls.onReleaseComputer,
    onOpenImportSetup: openImportSetup,
  };
  const threads = useChatThreads({ rpc, queries, active, rightPanel, userId, messageContext });
  const shell = (
    <BotsSidebarLayout
      userId={userId}
      collapsed={sidebar.collapsed}
      onCollapsedChange={sidebar.setCollapsedPref}
      onPreviewCollapsedChange={sidebar.setCollapsed}
      computerOpen={computerOpen}
      data-testid="shell-root"
      data-ready={shellReady}
      className="relative flex h-full min-h-0 min-w-0 overflow-hidden bg-background text-foreground/90 [&[data-resizing-sidebar]_*[data-slot=sidebar-gap]]:transition-none [&[data-resizing-sidebar]_*[data-slot=sidebar-container]]:transition-none"
      {...swipeHandlers}
    >
      <ComputerUpdateProgress
        onCompleted={() => {
          if (active) void refreshThread(active.id);
        }}
      />
      {bootstrapMe !== undefined ? (
        <HostComputerPrompt initialMe={bootstrapMe ?? undefined} onMeUpdated={setBootstrapMe} />
      ) : null}
      {userId && bootstrapMe ? (
        <TimezonePrompt
          key={userId}
          userId={userId}
          timezone={bootstrapMe.timezone}
          onSaved={(me, adopted) => setBootstrapMe((prev) => withSavedTimezone(prev, me, adopted))}
        />
      ) : null}
      <ShellSidebar
        isMobile={isMobileSidebar}
        mobileOpen={mobileSidebarOpen}
        setMobileOpen={setMobileSidebarOpen}
        density={botsSidebarDensity}
        collapsed={sidebar.collapsed}
        mini={sidebar.mini}
        setCollapsedPref={sidebar.setCollapsedPref}
        createMenuOpen={createMenuOpen}
        setCreateMenuOpen={setCreateMenuOpen}
        search={search}
        bots={bots}
        groups={groups}
        collapsedSidebarSections={collapsedSidebarSections}
        toggleSidebarSection={toggleSidebarSection}
        setPanel={setPanel}
        navigate={navigate}
        setNewSpaceOpen={dialogs.setNewSpaceOpen}
        setCreateBotOpen={dialogs.setCreateBotOpen}
        chatMenu={chatMenu}
        roster={
          <SidebarRoster
            mini={sidebar.mini}
            sidebarGroups={sidebar.sidebarGroups}
            collapsedSidebarSections={collapsedSidebarSections}
            bootstrapMe={bootstrapMe}
            botSections={botSections}
            spaces={spaces}
            rosterDropKey={rosterDrop.rosterDropKey}
            setRosterDropKey={rosterDrop.setRosterDropKey}
            rosterDropAction={rosterDrop.rosterDropAction}
            applyRosterDrop={rosterDrop.applyRosterDrop}
            openSpaceChat={openSpaceChat}
            openSpaceSettings={openSpaceSettings}
            setRenameSectionTarget={dialogs.setRenameSectionTarget}
            setDeleteSectionTarget={dialogs.setDeleteSectionTarget}
            toggleSidebarSection={toggleSidebarSection}
            inGroup={inGroup}
            active={active}
            activeGroup={activeGroup}
            botsSidebarDensity={botsSidebarDensity}
            dismissedRunErrorIds={composer.dismissedRunErrorIds}
            displayedRunError={composer.displayedRunError}
            draggedBotId={rosterDrop.draggedBotId}
            setDraggedBotId={rosterDrop.setDraggedBotId}
            chatMenu={chatMenu}
            reorderRosterBot={roster.reorderRosterBot}
            activeSnapshot={activeSnapshot}
          />
        }
        archived={
          <>
            <SnoozedChats
              snoozed={sidebar.snoozed}
              showSpaceSearch={search.showSpaceSearch}
              now={snoozeNow}
              snooze={snooze}
              openSpaceChat={openSpaceChat}
            />
            <ArchivedChats
              archivedBots={archivedBots}
              archivedGroups={archivedGroups}
              showSpaceSearch={search.showSpaceSearch}
              rpc={rpc}
              refreshBots={refreshBots}
              setDeleteTarget={dialogs.setDeleteTarget}
              setDeleteGroupTarget={dialogs.setDeleteGroupTarget}
            />
          </>
        }
        footerLogos={footerLogos}
        user={session.data?.user}
        boardEnabled={hasLab(bootstrapMe?.labs, "board")}
        navLinks={desktopBridge() ? [] : (bootstrapMe?.navLinks ?? [])}
        openSettings={openSettings}
        openIntegrations={() => setOverlay({ kind: "integrations" })}
        openSkills={() => setOverlay({ kind: "skills" })}
        openAgentImport={() => setOverlay({ kind: "import" })}
        openSpaceChat={openSpaceChat}
      />

      <ChatColumn
        drawerOpen={mobileSidebarOpen}
        covered={panelCoversChat}
        findOpen={findOpen}
        findInputRef={findInputRef}
        onCloseFind={() => {
          setFindOpen(false);
          focusComposer();
        }}
        header={
          <ChatHeader
            inGroup={inGroup}
            active={active}
            activeGroup={activeGroup}
            activeSnapshot={activeSnapshot}
            phoneCallsEnabled={Boolean(bootstrapMe?.phoneCallsEnabled)}
            meetingsEnabled={Boolean(bootstrapMe?.meetingsEnabled)}
            voiceReady={Boolean(voiceStatus?.ready)}
            inCall={Boolean(active) && call?.botId === active?.id}
            panelOpen={chatPanelOpen}
            threads={threads.header}
            onOpenNavigation={() => setMobileSidebarOpen(true)}
            onTogglePanel={toggleChatPanel}
            onCall={openCall}
          />
        }
        composer={
          <ChatComposerArea
            composer={composer}
            inGroup={inGroup}
            groupId={groupId}
            active={active}
            activeGroup={activeGroup}
            activeSnapshot={activeSnapshot}
            meId={userId}
            memberName={view.resolveMemberName}
            recordingSkill={Boolean(recordingSkill)}
            running={composerRunning}
            enterToSend={enterToSend}
            sendColors={userBubble}
            modelPicker={chatPreferences.composerModelPicker ? modelShortcuts.pickerProps : null}
            onBotSaved={(updated) =>
              setBots((current) => current.map((bot) => (bot.id === updated.id ? updated : bot)))
            }
            phoneCallsEnabled={bootstrapMe?.phoneCallsEnabled === true}
            dictationTranscribe={voiceStatus ? Boolean(voiceStatus.transcribe) : undefined}
            artifactTarget={view.artifactTarget}
            mentionTargets={composerMentionTargets}
            agentSkills={agentSkills}
            onSlashOpen={refreshAgentSkills}
            openSettings={openSettings}
            openChatSettings={openChatSettings}
            setPanel={setPanel}
            setModelFocusRequest={setModelFocusRequest}
          />
        }
      >
        {showNewBotPrompt ? (
          <div className="grid flex-1 place-items-center">
            <Button onClick={() => dialogs.setCreateBotOpen(true)}>
              <Plus size={16} aria-hidden="true" />
              <Trans>New bot</Trans>
            </Button>
          </div>
        ) : (
          <Transcript
            key={activeSnapshot?.threadId}
            meId={userId}
            scrollRef={thread.messageScroll}
            scrollRequest={scrollRequest}
            onScrollRequestHandled={clearScrollRequest}
            {...view.transcriptProps}
            {...composer.transcriptProps}
            markedUnreadMessageId={read.markedUnreadMessageId}
            showToolActivity={showToolActivity}
            unreadAfterSeq={read.unreadAfterSeq}
            loadingOlder={loadingOlder}
            userBubble={userBubble}
            onCallBack={
              bootstrapMe?.phoneCallsEnabled && !inGroup && active
                ? () => callBot(active)
                : undefined
            }
            onLoadOlder={loadOlder}
            {...messageContext}
            onAnswer={composer.answerMessage}
            onReply={replyToMessage}
            {...threads.transcriptProps}
            onMarkUnread={markMessageUnread}
            onQuote={quoteMessage}
            onQuoteShortcutChange={registerQuoteShortcut}
            onReact={composer.reactToMessage}
            onJumpToMessage={jumpToReplyMessage}
            onRefresh={refreshActiveThread}
            voiceReady={Boolean(voiceStatus?.ready)}
            speakingMessageId={speakingMessageId}
            callHoldsSpeaker={callHoldsSpeaker}
            onSpeak={speakMessage}
            onOpenAgentImport={openAgentImport}
            rpc={rpc}
          />
        )}
      </ChatColumn>

      <PageViewHost />
      <CallCard onSettings={() => openSettings("voice")} />
      <IncomingCall
        bots={bootstrapMe?.phoneCallsEnabled ? bots : []}
        transcribe={voiceStatus ? Boolean(voiceStatus.transcribe) : undefined}
        onAnswered={(botId) => navigate(`/app/${botId}`)}
      />

      <ShellSidePanel
        rpc={rpc}
        threads={threads.sidePanel}
        panel={panel}
        setPanel={setPanel}
        active={active}
        activeGroup={activeGroup}
        bots={bots}
        groups={groups}
        setBots={setBots}
        setGroups={setGroups}
        navigate={navigate}
        refreshBots={refreshBots}
        refreshGroupThread={refreshGroupThread}
        discardChatAttachments={composer.discardThreadAttachments}
        onCoversChat={setPanelCoversChat}
        onOverlays={setPanelOverlays}
        computerOpen={computerOpen}
        computerPanel={
          active ? (
            <ComputerPanel
              {...computerControls.panelProps(active)}
              sandboxProvider={bootstrapMe?.sandboxProvider}
              onRecovered={(sandboxProvider) => {
                setBootstrapMe((prev) => (prev ? { ...prev, sandboxProvider } : prev));
                computerControls.holdComputerRecovery();
              }}
              onOpenComputerSettings={
                bootstrapMe?.computerSettingsEnabled === true
                  ? () => openSettings("computer")
                  : undefined
              }
            />
          ) : null
        }
        routineList={routineList}
        routineEditorProps={routineEditorProps}
        openBot={openBot}
        modelFocusRequest={modelFocusRequest}
        onClearBot={(bot) => dialogs.setClearTarget({ kind: "bot", chat: bot })}
      />

      <Suspense fallback={null}>
        <ShellDialogs
          dialogs={dialogs}
          rpc={rpc}
          bots={bots}
          activeId={active?.id}
          activeGroupId={activeGroup?.id}
          alive={alive}
          navigate={navigate}
          setPanel={setPanel}
          refreshBots={refreshBots}
          closeMobileSidebar={() => setMobileSidebarOpen(false)}
          createBot={createBot}
          botAvatarSet={bootstrapMe?.botAvatarSet ?? DEFAULT_NEW_BOT_AVATAR_SET}
          discardChatAttachments={composer.discardThreadAttachments}
          clearOpenThread={thread.clearOpenThread}
          deleteRoutineDialogProps={deleteRoutineDialogProps}
          paletteActions={paletteActions}
        />
        <AppOverlays
          overlay={overlay}
          setOverlay={setOverlay}
          activeBotId={activeBotId.current}
          stdioEnabled={bootstrapMe?.mcpStdioEnabled === true}
          messagingEnabled={messagingSurfaceEnabled}
          onConnectedAppsChange={setFooterLogos}
          onOpenBot={(bot) => {
            openCreatedBot(bot);
            // As after any new bot: the Space's sections and counts come from the server.
            void bestEffort("refresh bots after opening one", refreshBots());
          }}
        />
      </Suspense>

      <Suspense fallback={null}>
        <SettingsOverlays
          rpc={rpc}
          queries={queries}
          overlay={overlay}
          setOverlay={setOverlay}
          settingsSpace={settingsSpace}
          showSettings={settingsSpaceId === null || Boolean(settingsSpace)}
          spaces={spaces}
          renameSpace={renameSpace}
          removeSpace={removeSpace}
          leftSpace={leftSpace}
          refreshSpaces={() => refreshBots()}
          alive={alive}
          user={session.data?.user}
          refetchSession={() => session.refetch({ query: { disableCookieCache: true } })}
          bootstrapMe={bootstrapMe}
          setBootstrapMe={setBootstrapMe}
          messagingEnabled={messagingSurfaceEnabled}
          memoryConfig={memoryProviderConfig}
          peerConversation={peerConversation}
          setPeerConversation={setPeerConversation}
          active={active}
          peerBot={view.resolveBot}
          openNewSpace={() => dialogs.setNewSpaceOpen(true)}
        />
      </Suspense>

      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        host={{ desktop: Boolean(desktopBridge()), apple: isApplePlatform() }}
        dictation={Boolean(bootstrapMe?.phoneCallsEnabled)}
        modelPicker={chatPreferences.composerModelPicker}
      />

      {computerOpen && computerBot ? (
        <ComputerOverlay
          {...computerControls.screenProps}
          bot={computerBot}
          computerViewport={computerState.computerViewport}
          recordingSkill={recordingSkill}
          teachBusy={teachBusy}
          hasControl={computerControls.hasControl}
          composerRunning={composerRunning}
          sending={sending}
          sendError={sendError}
          onStopTeaching={stopTeaching}
          onStopRun={() => void stopRun()}
          onRelease={computerControls.releaseComputer}
          onTakeControl={() => void openComputer(computerBot.id, true)}
          onStart={() => void openComputer(computerBot.id)}
          onRefreshTeaching={refreshActiveTeaching}
          onClose={() => setComputerOpen(false)}
        />
      ) : null}
    </BotsSidebarLayout>
  );

  // Render nothing until the first bot list lands so the chat chrome does not flash a bot-less state.
  return (
    <SpaceRpcProvider spaceId={shellSpaceId}>
      {initialBotsLoaded || initialLoadFailed ? (
        <InboundOriginProvider value={bootstrapMe?.inboundOrigin}>
          <PagesProvider value={pages}>{shell}</PagesProvider>
        </InboundOriginProvider>
      ) : (
        <PageLoading />
      )}
    </SpaceRpcProvider>
  );
}
