import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/native";
import type {
  AgentSkillCatalogEntry,
  Connection,
  ConnectionCatalogItem,
  MessageBlock,
  Routine,
} from "@rakazo/contracts";
import {
  canReactToThreadMessage,
  MESSAGE_REACTIONS,
  type MessageReaction,
} from "@rakazo/contracts";
import type { ThreadItem } from "@rakazo/core";
import {
  abortableDelay,
  appendNewerThreadPage,
  attachmentsForThread,
  buildComposerMentionOptions,
  type ComposerMention,
  cloudAgentHttpsUrl,
  formatFileSize,
  formatMessageTime,
  forwardProbeAfterPage,
  groupVoiceChats,
  isApprovalAskBlock,
  isRunTerminalEvent,
  isSecretAskBlock,
  latestAnswerableAskMessageId,
  leaveThreadWindow,
  mentionChipKey,
  openThreadWindow,
  plainTextFromMarkdown,
  projectMessageReactions,
  resolveComposerSendPlan,
  resolvePersonaColorDef,
  SLASH_ACTIONS,
  type SlashActionId,
  selectedAskActionLabel,
  serializeComposerPrompt,
  threadWindowMessages,
  truncateSlashDescription,
  userVisibleMessages,
  withLiveStreamingProgress,
} from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import {
  useFocusEffect,
  useIsFocused,
  useLocalSearchParams,
  useNavigation,
  useRouter,
} from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  Linking,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextProps,
  View,
} from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppConnectCard } from "../components/AppConnectCard";
import { AskActions } from "../components/AskActions";
import { BotAvatar } from "../components/bot-avatar";
import { ChoiceCard } from "../components/ChoiceCard";
import { ComputerCard } from "../components/ComputerCard";
import { GlassSurface } from "../components/glass-surface";
import type { ImageArtifactPreviewTarget } from "../components/image-artifact-viewer";
import { InlineImageAttachment } from "../components/inline-image-attachment";
import { McpApprovalCard } from "../components/McpApprovalCard";
import {
  MarkdownArtifactPreview,
  type MarkdownArtifactPreviewTarget,
} from "../components/markdown-artifact-preview";
import { MessageContextMenu } from "../components/message-context-menu";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSymbol } from "../components/native-symbol";
import { SelectTextSheet } from "../components/select-text-sheet";
import { VoiceChatCard } from "../components/VoiceChatCard";
import { WorkingIndicator } from "../components/WorkingIndicator";
import {
  applyMobileThreadEvent,
  blockText,
  copyableMobileMessageText,
  currentApiBase,
  loadSessionToken,
  type MobileBot,
  type MobileGroup,
  type MobileMessage,
  type MobileMessagePage,
  type MobileSnapshot,
  mergeMobileSnapshot,
  messagingProviderLabel,
  mobileThreadRefreshResult,
  prependMobileMessagePage,
  rpc,
  selectableMobileMessageText,
  selectedSpaceId,
  selectSpace,
  subscribeThread,
} from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { type MobileArtifactTarget, openMobileArtifact } from "../lib/artifact-open";
import { nextAutoSpeakAction } from "../lib/auto-speak";
import { confirmDeleteBot } from "../lib/bot-lifecycle";
import { setCallProviderTranscribe, startCall, useCallSession } from "../lib/call-session";
import { transparentColor } from "../lib/color";
import { loadDeviceVoiceEnabled } from "../lib/device-voice";
import { available as dictationAvailable } from "../lib/dictation";
import { cancelFocusPrompt, focusPromptThreadActive } from "../lib/focus-prompt";
import { dateLocaleForUi, t, useI18n } from "../lib/i18n";
import { isInlineImageMimeType } from "../lib/inline-image";
import { saveLastBotId } from "../lib/last-bot";
import {
  dismissThreadNotifications,
  resumeLiveNotifications,
  setOpenNotificationThread,
} from "../lib/live-notifications";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { buildMessageContextMenu, messageMenuReaction } from "../lib/message-context-menu";
import {
  applyLocalChoiceDismissals,
  hasVisibleMessagePresentation,
  isCenteredAgentEvent,
  messagePresentationSegments,
  quotableMessageSegments,
  truncateQuoteExcerpt,
} from "../lib/message-presentation";
import { native, useMobileTokens, useResolvedAppearance, useThemedStyles } from "../lib/native";
import {
  threadRouteSpaceOnFocus,
  threadSpaceRequest,
  threadSpaceSwitchResult,
} from "../lib/notification-open";
import {
  type PickedAttachment,
  pickDocuments,
  pickFromLibrary,
  takePhoto,
} from "../lib/pick-attachments";
import { threadRefreshDelayMs } from "../lib/refresh";
import {
  getCachedResponseStreamingEnabled,
  subscribeResponseStreaming,
} from "../lib/response-streaming";
import { selectableTextFromMarkdown } from "../lib/selectable-text";
import { ThreadJumpAnchor } from "../lib/thread-jump";
import {
  type ThreadScrollAction,
  ThreadScrollBehavior,
  type ThreadScrollState,
} from "../lib/thread-scroll";
import { errorText } from "../lib/user-error";
import { speakQueue, speakText } from "../lib/voice";
import { probeProviderTranscribe, resolveVoiceCallPlan } from "../lib/voice-call-entry";

type PendingAttachment = PickedAttachment & { threadKey: string };
type AskAction = NonNullable<Extract<MessageBlock, { kind: "ask" }>["actions"]>[number];

function newClientNonce(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatApprovalAnswer(
  answer: string | undefined,
  actions: AskAction[] | undefined,
  approval: boolean,
): string {
  if (!answer) return t("Answered");
  const selectedAction = actions?.find((action) => action.id === answer);
  const outcome = selectedAction?.outcome;
  if (approval && outcome === "created") return t("Created");
  if (approval && outcome === "cancelled") return t("Cancelled");
  if (approval && answer === "allow") return t("Allowed once");
  if (approval && answer === "always") return t("Always allowed");
  if (approval && answer === "deny") return t("Denied");
  return t("Answered: {answer}", { answer: selectedAskActionLabel(answer, actions) });
}

function formatAttachmentSkip(item: { name: string; reason: string }): string {
  const name = item.name === "camera" ? t("Camera") : item.name;
  if (item.reason === "permission denied") return t("{name} (permission denied)", { name });
  if (item.reason === "over 10 MiB") return t("{name} (over 10 MiB)", { name });
  if (item.reason === "unsupported type") return t("{name} (unsupported type)", { name });
  const maxMatch = /^max (\d+) attachments$/.exec(item.reason);
  if (maxMatch) {
    return t("{name} (max {count} attachments)", { name, count: maxMatch[1] ?? "" });
  }
  return `${name} (${item.reason})`;
}

function isWorkingStatus(status: string | undefined): boolean {
  return (
    status === "queued" ||
    status === "leased" ||
    status === "running" ||
    status === "waiting_input" ||
    status === "waiting_takeover"
  );
}

const ATTACHMENT_PLACEHOLDER_LINE = /^\[(?:image|file|chart): .*\]$/;

function speakableMessageText(message: MobileMessage): string {
  return blockText(message)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !ATTACHMENT_PLACEHOLDER_LINE.test(line))
    .join("\n");
}

export default function ThreadRoute() {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const focused = useIsFocused();
  const { spaceId } = useLocalSearchParams<{ spaceId?: string | string[] }>();
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(() => selectedSpaceId());
  const [switchFailed, setSwitchFailed] = useState(false);
  const [appliedFocus, setAppliedFocus] = useState(focused);
  // Before paint, so a stacked route cannot render its thread against a space
  // a newer notification selected.
  const focusSync = threadRouteSpaceOnFocus({
    focused,
    appliedFocus,
    activeSpaceId,
    liveSpaceId: selectedSpaceId(),
    switchFailed,
  });
  if (focusSync.appliedFocus !== appliedFocus) setAppliedFocus(focusSync.appliedFocus);
  if (focusSync.activeSpaceId !== activeSpaceId) setActiveSpaceId(focusSync.activeSpaceId);
  if (focusSync.switchFailed !== switchFailed) setSwitchFailed(focusSync.switchFailed);
  const request = threadSpaceRequest(spaceId, focusSync.activeSpaceId);

  useEffect(() => {
    if (!focused) return;
    const next = threadSpaceRequest(spaceId, activeSpaceId);
    if (next.action === "show") {
      setSwitchFailed(false);
      return;
    }
    if (next.action === "unavailable") {
      setSwitchFailed(true);
      return;
    }
    let cancelled = false;
    setSwitchFailed(false);
    const requestedSpaceId = next.spaceId;
    void selectSpace(requestedSpaceId).then((switched) => {
      if (cancelled) return;
      // selectSpace commits the id before it resolves; a failed write rolls it back.
      if (threadSpaceSwitchResult(requestedSpaceId, switched, selectedSpaceId()) === "ready") {
        setActiveSpaceId(requestedSpaceId);
        return;
      }
      setSwitchFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [activeSpaceId, focused, spaceId]);

  if (request.action === "show" && !focusSync.switchFailed) return <Thread />;
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tokens.background,
      }}
    >
      {request.action === "switch" && !focusSync.switchFailed ? (
        <ActivityIndicator color={tokens.foreground} />
      ) : (
        <View style={{ alignItems: "center", gap: 12 }}>
          <Text style={{ color: tokens.foreground, fontSize: 16 }}>
            {t("Could not switch spaces")}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => router.replace("/")}>
            <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Return to inbox")}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function createThreadHeaderStyles() {
  const tokens = mobileTokens();
  const transparentBackground = transparentColor(tokens.background);
  return StyleSheet.create({
    titleCapsule: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      maxWidth: 220,
      paddingVertical: 4,
      paddingStart: 6,
      paddingEnd: 14,
      borderRadius: 999,
    },
    titleCapsuleFill: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.border,
      backgroundColor: tokens.card,
    },
    title: {
      color: tokens.foreground,
      fontSize: 18,
      fontWeight: "600",
    },
    circleButton: {
      flex: 1,
      borderRadius: 999,
      alignItems: "center",
      justifyContent: "center",
    },
    composerFill: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.border,
      backgroundColor: tokens.card,
    },
    headerFade: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      experimental_backgroundImage: `linear-gradient(to bottom, ${tokens.background} 0%, ${tokens.background} 58%, ${transparentBackground} 100%)`,
    },
    composerFade: {
      position: "absolute",
      bottom: "100%",
      left: -20,
      right: -20,
      height: 24,
      experimental_backgroundImage: `linear-gradient(to top, ${tokens.background} 0%, ${transparentBackground} 100%)`,
    },
  });
}

function Thread() {
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const styles = useThemedStyles(createThreadHeaderStyles);
  const [botActionsOpen, setBotActionsOpen] = useState(false);
  const { t } = useI18n();
  const navigation = useNavigation();
  const router = useRouter();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const { botId, groupId, name, messageId, threadId } = useLocalSearchParams<{
    botId?: string;
    groupId?: string;
    name?: string;
    messageId?: string;
    threadId?: string;
  }>();
  const requestedThreadId = typeof threadId === "string" && threadId ? threadId : undefined;
  const inGroup = Boolean(groupId);
  const call = useCallSession();
  const onCall = Boolean(botId) && call?.botId === botId;
  const voiceCallStarting = useRef(false);
  const scroll = useRef<FlatList<ThreadItem<MobileMessage>>>(null);
  const pinnedScroll = useRef<ScrollView>(null);
  const scrollBehavior = useRef(new ThreadScrollBehavior());
  const userDragging = useRef(false);
  const loadingOlderContent = useRef(false);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const jumpGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const liveSubscribed = useRef(false);
  const liveSubscriptionGeneration = useRef(0);
  const pinnedAroundRef = useRef<{
    botId?: string;
    groupId?: string;
    messageId: string;
    threadId: string;
    newerCursor: number | null;
    coveredThroughSeq?: number;
    probeSeq?: number;
  } | null>(null);
  const jumpScrollTarget = useRef<string | null>(null);
  const jumpAnchor = useRef(new ThreadJumpAnchor());
  const activeBotId = useRef(botId);
  activeBotId.current = botId;
  const activeGroupId = useRef(groupId);
  activeGroupId.current = groupId;
  const routeName = useRef(name);
  routeName.current = name;
  const mentionBotsRefreshGeneration = useRef(0);
  const mentionBotsAppliedGeneration = useRef(0);
  const readVisibleTarget = useRef<string | null>(null);
  const autoSpoken = useRef<string | null>(null);
  const autoSpokenBotId = useRef<string | null>(null);
  const threadKey = groupId ?? botId;
  const [threadScrollState, setThreadScrollState] = useState<ThreadScrollState>(() =>
    scrollBehavior.current.state(),
  );
  useLayoutEffect(() => {
    scrollBehavior.current.openThread(threadKey ?? "");
    expandedHistoryThread.current = null;
    pinnedAroundRef.current = null;
    jumpScrollTarget.current = null;
    jumpAnchor.current.release();
    joinPinnedAfterLayout.current = null;
    loadingOlderContent.current = false;
    setThreadScrollState(scrollBehavior.current.state());
  }, [threadKey]);
  const reducedMotion = useReducedMotion();
  const artifactTarget: MobileArtifactTarget | undefined = groupId
    ? { groupId }
    : botId
      ? { botId }
      : undefined;
  const [snap, setSnap] = useState<MobileSnapshot | null>(null);
  const snapRef = useRef<MobileSnapshot | null>(null);
  const streamResponses = useSyncExternalStore(
    subscribeResponseStreaming,
    getCachedResponseStreamingEnabled,
    () => false,
  );
  const streamResponsesRef = useRef(streamResponses);
  streamResponsesRef.current = streamResponses;

  function commitSnap(next: MobileSnapshot | null) {
    snapRef.current = next;
    setSnap(withLiveStreamingProgress(next, streamResponsesRef.current));
  }

  useEffect(() => {
    setSnap(withLiveStreamingProgress(snapRef.current, streamResponses));
  }, [streamResponses]);
  const activeThreadId = useRef<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [agentSkills, setAgentSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [mentionBots, setMentionBots] = useState<MobileBot[]>([]);
  const [mentionGroups, setMentionGroups] = useState<MobileGroup[]>([]);
  const [mentionRoutines, setMentionRoutines] = useState<Array<Routine & { botName?: string }>>([]);
  const [mentionConnectors, setMentionConnectors] = useState<
    Array<{
      id: string;
      name: string;
      authStatus: "connected" | "needs_auth";
      connectionId?: string;
    }>
  >([]);
  const [selectedMentions, setSelectedMentions] = useState<ComposerMention[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [replyTarget, setReplyTarget] = useState<MobileMessage | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const [quoteTarget, setQuoteTarget] = useState<MobileMessage | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selectableText, setSelectableText] = useState<string | null>(null);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const loadingNewerContent = useRef(false);
  // A failed newer page waits for the next drag instead of retrying on every scroll event.
  const newerLoadFailed = useRef(false);
  const pinnedScrollMetrics = useRef({ offset: 0, viewport: 0, content: 0 });
  const joinPinnedAfterLayout = useRef<number | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownArtifactPreviewTarget | null>(
    null,
  );
  const [dismissedChoiceQuestions, setDismissedChoiceQuestions] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const reactionView = useMemo(
    () =>
      projectMessageReactions(
        userVisibleMessages(snap?.messages ?? [], { includePeerReceipts: true })
          .map((message) => {
            const dismissed = dismissedChoiceQuestions.get(message.id);
            if (!dismissed) return message;
            const blocks = applyLocalChoiceDismissals(message.blocks, dismissed);
            return blocks === message.blocks ? message : { ...message, blocks: [...blocks] };
          })
          .filter((message) => hasVisibleMessagePresentation(message.blocks)),
      ),
    [dismissedChoiceQuestions, snap?.messages],
  );
  const visibleMessages = reactionView.visibleMessages;
  const latestMessageId = visibleMessages.at(-1)?.id ?? null;
  const activePendingAttachments = attachmentsForThread(pendingAttachments, threadKey);
  const composerMentionTargets = useMemo(
    () =>
      buildComposerMentionOptions({
        query: "",
        includeEveryone: inGroup,
        currentGroupId: groupId,
        bots: mentionBots.map((bot) => ({
          id: bot.id,
          name: bot.name,
          color: bot.color,
        })),
        groups: mentionGroups.map((group) => ({
          id: group.id,
          name: group.name,
        })),
        routines: mentionRoutines.map((routine) => ({
          id: routine.id,
          name: routine.name,
          crons: routine.crons,
          botId: routine.botId,
          botName: routine.botName,
        })),
        connectors: mentionConnectors,
      }),
    [groupId, inGroup, mentionBots, mentionConnectors, mentionGroups, mentionRoutines],
  );
  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || composerMentionTargets.length === 0) return [];
    const query = mentionQuery.trim().toLowerCase();
    return composerMentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [composerMentionTargets, mentionQuery]);
  const slashQueryNormalized = slashQuery?.trim().toLowerCase() ?? null;
  const slashSkillOptions =
    slashQuery !== null && mentionQuery === null
      ? agentSkills
          .filter((skill) => {
            if (!slashQueryNormalized) return true;
            return (
              skill.name.toLowerCase().includes(slashQueryNormalized) ||
              skill.description.toLowerCase().includes(slashQueryNormalized)
            );
          })
          .slice(0, 8)
      : [];
  const slashActionOptions =
    slashQuery !== null && mentionQuery === null
      ? SLASH_ACTIONS.filter((action) => {
          if (!slashQueryNormalized) return true;
          const label = t(action.label);
          return (
            action.label.toLowerCase().includes(slashQueryNormalized) ||
            label.toLowerCase().includes(slashQueryNormalized)
          );
        })
      : [];
  const currentBot = botId ? mentionBots.find((bot) => bot.id === botId) : undefined;
  const displayName = currentBot?.name ?? name;
  const composerPrompt = displayName ? t("Message {name}", { name: displayName }) : t("Message…");
  const notificationThreadId = snap?.threadId ?? requestedThreadId ?? currentBot?.threadId;
  activeThreadId.current = notificationThreadId;
  const currentBotStatus = snap ? snap.run?.status : currentBot?.status;
  const hasLiveProgress = visibleMessages.some((message) => message.id.startsWith("progress:"));
  const workingGroupBots = useMemo(() => {
    if (!inGroup) return [];
    const seen = new Set<string>();
    const working = snap?.activeRuns ?? (snap?.run ? [snap.run] : []);
    return working.flatMap((run) => {
      if (!run.botId || seen.has(run.botId) || !isWorkingStatus(run.status)) return [];
      const member = snap?.members?.find((candidate) => candidate.botId === run.botId);
      if (!member) return [];
      seen.add(run.botId);
      return [{ ...member, status: run.status }];
    });
  }, [inGroup, snap?.activeRuns, snap?.members, snap?.run]);
  const working = inGroup ? workingGroupBots.length > 0 : isWorkingStatus(currentBotStatus);

  const speakFinishedReply = useCallback(() => {
    if (!botId || inGroup || !currentBot) return;
    const decision = nextAutoSpeakAction({
      botId: currentBot.id,
      autoSpeak: currentBot.autoSpeak,
      focused: AppState.currentState === "active" && navigation.isFocused(),
      snapshotReady: snap?.botId === currentBot.id,
      lastSpokenBotId: autoSpokenBotId.current,
      lastSpokenMessageId: autoSpoken.current,
      runStatus: snap?.run?.status,
      messages: snap?.messages ?? [],
    });
    if (decision.action === "seed") {
      autoSpokenBotId.current = currentBot.id;
      autoSpoken.current = decision.messageId;
      return;
    }
    if (decision.action !== "speak") return;
    autoSpokenBotId.current = currentBot.id;
    autoSpoken.current = decision.messageId;
    void speakText(decision.text, {
      botId: currentBot.id,
      speaker: {
        name: currentBot.name,
        color: resolvePersonaColorDef(currentBot.id, currentBot.color).light,
      },
    }).catch(() => undefined);
  }, [botId, inGroup, currentBot, navigation, snap?.botId, snap?.messages, snap?.run?.status]);

  useEffect(() => {
    speakFinishedReply();
    const appState = AppState.addEventListener("change", speakFinishedReply);
    return () => appState.remove();
  }, [speakFinishedReply]);

  useEffect(() => {
    void rpc<AgentSkillCatalogEntry[]>("agentSkills/list")
      .then(setAgentSkills)
      .catch(() => setAgentSkills([]));
  }, []);

  useEffect(() => {
    setThreadScrollState(scrollBehavior.current.state());
  }, [threadKey]);

  const refreshMentionBots = useCallback(async () => {
    if (!botId && !groupId) return;
    const generation = ++mentionBotsRefreshGeneration.current;
    const targetBotId = botId;
    try {
      const bots = await rpc<MobileBot[]>("bots/list");
      // Apply any successful response that is still the newest applied so far.
      // A later failed refresh must not discard an earlier success.
      if (generation < mentionBotsAppliedGeneration.current) return;
      if (targetBotId !== activeBotId.current) return;
      mentionBotsAppliedGeneration.current = generation;
      setMentionBots(bots);
      if (targetBotId) {
        const next = bots.find((bot) => bot.id === targetBotId);
        // Read the route name from a ref so renaming does not recreate this
        // callback (and restart the SSE subscription that depends on it).
        if (next?.name && next.name !== routeName.current) {
          router.setParams({ name: next.name });
        }
      }
    } catch {
      // Keep the last known roster if refresh fails.
    }
  }, [botId, groupId, router]);

  useEffect(() => {
    void refreshMentionBots();
    void rpc<MobileGroup[]>("groups/list")
      .then(setMentionGroups)
      .catch(() => setMentionGroups([]));
  }, [refreshMentionBots]);

  useEffect(() => {
    if (mentionBots.length === 0) {
      setMentionRoutines([]);
      setMentionConnectors([]);
      return;
    }
    let cancelled = false;
    const botNameById = new Map(mentionBots.map((bot) => [bot.id, bot.name]));
    void Promise.all(
      mentionBots.map((bot) =>
        rpc<Routine[]>("routines/list", { botId: bot.id })
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
      rpc<Connection[]>("connections/list").catch(() => [] as Connection[]),
      rpc<ConnectionCatalogItem[]>("connections/catalog", {}).catch(
        () => [] as ConnectionCatalogItem[],
      ),
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
  }, [mentionBots]);

  function isCurrentTarget(targetBotId: string | undefined, targetGroupId: string | undefined) {
    return activeBotId.current === targetBotId && activeGroupId.current === targetGroupId;
  }

  useLayoutEffect(() => {
    navigation.setOptions({
      title: displayName || t("Thread"),
      // Messages scroll under the bar. The list is inverted, so iOS would draw the header's scroll
      // edge effect at its flipped top, above the composer.
      headerTransparent: true,
      headerStyle: { backgroundColor: "transparent" },
      scrollEdgeEffects: { top: "hidden" },
      headerTitle: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={!inGroup && botId ? t("Chat settings") : displayName || t("Thread")}
          disabled={inGroup || !botId}
          onPress={() => {
            if (!botId || inGroup) return;
            router.push({ pathname: "/bot-settings", params: { botId } });
          }}
        >
          <GlassSurface style={styles.titleCapsule} fallbackStyle={styles.titleCapsuleFill}>
            {!inGroup && currentBot ? (
              <BotAvatar
                color={currentBot.color}
                identity={currentBot.id}
                size={28}
                status={currentBotStatus}
                muted={!currentBot.notifyOnFinish}
              />
            ) : null}
            <Text numberOfLines={1} style={styles.title}>
              {displayName || t("Thread")}
            </Text>
          </GlassSurface>
        </Pressable>
      ),
      headerRight: () =>
        inGroup ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Group settings")}
            hitSlop={8}
            onPress={() =>
              router.push({
                pathname: "/group-settings",
                params: { groupId: groupId ?? "" },
              })
            }
          >
            <NativeSymbol
              ios="gearshape"
              android="settings-outline"
              size={21}
              color={tokens.foreground}
            />
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Bot actions")}
            hitSlop={8}
            onPress={showBotActions}
          >
            <NativeSymbol
              ios="ellipsis"
              android="ellipsis-horizontal"
              size={21}
              color={tokens.foreground}
            />
          </Pressable>
        ),
    });
  }, [
    botId,
    currentBot,
    currentBotStatus,
    displayName,
    groupId,
    inGroup,
    navigation,
    router,
    t,
    tokens,
    colorScheme,
    styles,
  ]);

  function leaveBot() {
    router.dismissAll();
    router.replace("/");
  }

  function clearConversation() {
    if (!botId) return;
    setError(null);
    void rpc("threads/clear", { botId })
      .then(() => {
        expandedHistoryThread.current = null;
        pinnedAroundRef.current = null;
        historyEpoch.current += 1;
        commitSnap(
          snapRef.current
            ? { ...snapRef.current, messages: [], olderCursor: null, run: null }
            : snapRef.current,
        );
      })
      .catch((err: unknown) => setError(errorText(err, t("Could not clear conversation"))));
  }

  const botActions = [
    {
      text: t("Chat settings"),
      onPress: () =>
        router.push({
          pathname: "/bot-settings",
          params: { botId: botId ?? "" },
        }),
    },
    {
      text: t("Open computer"),
      onPress: () =>
        router.push({
          pathname: "/computer",
          params: { botId: botId ?? "", name: displayName ?? t("Bot") },
        }),
    },
    {
      text: t("Clear conversation"),
      destructive: true,
      onPress: () =>
        Alert.alert(
          t("Clear conversation?"),
          t(
            "This removes every message and stops current work. The bot, computer, memory, and routines are kept.",
          ),
          [
            { text: t("Cancel"), style: "cancel" },
            { text: t("Clear"), style: "destructive", onPress: clearConversation },
          ],
        ),
    },
    {
      text: t("Archive"),
      onPress: () =>
        void rpc("bots/archive", { botId })
          .then(leaveBot)
          .catch((error) =>
            Alert.alert(t("Could not archive bot"), errorText(error, t("Try again."))),
          ),
    },
    {
      text: t("Delete…"),
      destructive: true,
      onPress: () => confirmDeleteBot({ id: botId ?? "", name: displayName || t("Bot") }, leaveBot),
    },
  ];

  function showBotActions() {
    if (!botId) return;
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: name || t("Bot"),
          userInterfaceStyle: colorScheme,
          options: [...botActions.map((action) => action.text), t("Cancel")],
          cancelButtonIndex: botActions.length,
          destructiveButtonIndex: botActions.flatMap((action, index) =>
            action.destructive ? [index] : [],
          ),
        },
        (index) => botActions[index]?.onPress(),
      );
      return;
    }
    setBotActionsOpen(true);
  }

  async function refresh() {
    if (!botId && !groupId) return;
    const targetBotId = botId;
    const targetGroupId = groupId;
    const epoch = historyEpoch.current;
    const generation = ++refreshGeneration.current;
    const next = await rpc<MobileSnapshot>(
      "threads/get",
      targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! },
    );
    // Only the newest started refresh may commit. Threads also receive live
    // events; an older snapshot must not overwrite those while a newer refresh
    // is already in flight. The subscription starts from the snapshot returned
    // here, so a discarded fetch must not supply its cursor.
    const result = mobileThreadRefreshResult({
      fetched: next,
      onScreen: snapRef.current,
      requestGeneration: generation,
      currentGeneration: refreshGeneration.current,
      requestEpoch: epoch,
      currentEpoch: historyEpoch.current,
      targetBotId,
      targetGroupId,
      activeBotId: activeBotId.current,
      activeGroupId: activeGroupId.current,
    });
    if (result.commit) {
      commitSnap(
        mergeMobileSnapshot(snapRef.current, next, expandedHistoryThread.current === next.threadId),
      );
    }
    return result.snapshot ?? undefined;
  }

  async function applyMessageJump(target: { botId?: string; groupId?: string; messageId: string }) {
    const threadTarget = target.groupId ? { groupId: target.groupId } : { botId: target.botId! };
    const epoch = historyEpoch.current;
    jumpGeneration.current += 1;
    const jumpId = jumpGeneration.current;
    const [snap, page] = await Promise.all([
      rpc<MobileSnapshot>("threads/get", threadTarget),
      rpc<MobileMessagePage>("threads/messages", {
        ...threadTarget,
        around: { messageId: target.messageId },
      }),
    ]);
    // The epoch check drops a jump that raced a conversation clear (or a bot switch); the
    // generation check drops an older same-thread jump that finished after a newer one.
    if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
    if (target.groupId && activeGroupId.current !== target.groupId) return;
    if (target.botId && activeBotId.current !== target.botId) return;
    const targetInPage = page.messages.some((message) => message.id === target.messageId);
    const opened = targetInPage ? openThreadWindow(snap, page) : null;
    expandedHistoryThread.current = targetInPage ? page.threadId : null;
    pinnedAroundRef.current = opened
      ? {
          ...threadTarget,
          messageId: target.messageId,
          threadId: page.threadId,
          newerCursor: opened.newerCursor,
        }
      : null;
    jumpAnchor.current.begin(targetInPage ? target.messageId : null);
    jumpScrollTarget.current = targetInPage ? target.messageId : null;
    newerLoadFailed.current = false;
    joinPinnedAfterLayout.current = null;
    pinnedScrollMetrics.current = { offset: 0, viewport: 0, content: 0 };
    commitSnap(opened?.snapshot ?? snap);
  }

  async function loadNewerMessages() {
    const pinned = pinnedAroundRef.current;
    if (
      (!botId && !groupId) ||
      pinned?.newerCursor == null ||
      loadingNewerContent.current ||
      newerLoadFailed.current
    )
      return;
    loadingNewerContent.current = true;
    setLoadingNewer(true);
    const epoch = historyEpoch.current;
    const probe = pinned.probeSeq ?? pinned.newerCursor + 1;
    let visibleUnchanged = false;
    try {
      // Pages come back centered on the seq, so the one after the cursor overlaps what is loaded.
      const page = await rpc<MobileMessagePage & { coveredThroughSeq?: number }>(
        "threads/messages",
        {
          ...(groupId ? { groupId } : { botId: botId! }),
          around: { seq: probe },
        },
      );
      if (epoch !== historyEpoch.current || pinnedAroundRef.current !== pinned || !snapRef.current)
        return;
      const visibleBefore = threadWindowMessages(
        snapRef.current.messages,
        pinned.newerCursor,
      ).length;
      const reported = page.coveredThroughSeq ?? null;
      const carried =
        reported == null ? undefined : Math.max(pinned.coveredThroughSeq ?? reported, reported);
      const next = appendNewerThreadPage(
        snapRef.current,
        pinned.newerCursor,
        page,
        reported == null ? null : carried,
      );
      const step = forwardProbeAfterPage({
        probe,
        newerCursor: pinned.newerCursor,
        nextCursor: next.newerCursor,
        reportedCoverage: reported,
        carriedCoverage: pinned.coveredThroughSeq,
      });
      if (step.stalled) newerLoadFailed.current = true;
      visibleUnchanged =
        threadWindowMessages(next.snapshot.messages, next.newerCursor).length === visibleBefore;
      pinnedAroundRef.current = {
        ...pinned,
        newerCursor: next.newerCursor,
        coveredThroughSeq: step.coverage,
        probeSeq: step.probe,
      };
      commitSnap(next.snapshot);
      if (next.newerCursor == null) {
        joinPinnedAfterLayout.current = pinnedScrollMetrics.current.content;
      }
    } catch (err) {
      if (epoch !== historyEpoch.current || pinnedAroundRef.current !== pinned) return;
      newerLoadFailed.current = true;
      setError(errorText(err, t("Could not open message")));
    } finally {
      loadingNewerContent.current = false;
      setLoadingNewer(false);
      if (visibleUnchanged) loadNewerNearEnd();
    }
  }

  function showLatest() {
    const pinned = pinnedAroundRef.current;
    pinnedAroundRef.current = null;
    joinPinnedAfterLayout.current = null;
    jumpScrollTarget.current = null;
    jumpAnchor.current.release();
    expandedHistoryThread.current = null;
    // The live list mounts at the latest message.
    scrollBehavior.current.jumpToLatest();
    setThreadScrollState(scrollBehavior.current.state());
    commitSnap(
      snapRef.current && pinned
        ? leaveThreadWindow(snapRef.current, pinned.newerCursor)
        : snapRef.current,
    );
  }

  async function loadOlderMessages() {
    if ((!botId && !groupId) || snap?.olderCursor == null || loadingOlder) return;
    loadingOlderContent.current = true;
    setLoadingOlder(true);
    const epoch = historyEpoch.current;
    const pinned = pinnedAroundRef.current;
    try {
      const page = await rpc<MobileMessagePage>("threads/messages", {
        ...(groupId ? { groupId } : { botId: botId! }),
        before: snap.olderCursor,
        includePeerReceipts: true,
      });
      if (epoch !== historyEpoch.current || pinnedAroundRef.current !== pinned) {
        loadingOlderContent.current = false;
        return;
      }
      expandedHistoryThread.current = page.threadId;
      commitSnap(prependMobileMessagePage(snapRef.current, page));
    } catch (err) {
      loadingOlderContent.current = false;
      setError(errorText(err, t("Could not load earlier messages")));
    } finally {
      setLoadingOlder(false);
    }
  }

  const markReadIfVisible = useCallback(() => {
    if (AppState.currentState !== "active" || !navigation.isFocused()) return;
    const target = groupId ?? botId;
    if (!target || readVisibleTarget.current === target) return;
    readVisibleTarget.current = target;
    if (activeThreadId.current) {
      void dismissThreadNotifications({ threadId: activeThreadId.current }).catch(() => undefined);
    }
    if (groupId) {
      void rpc("threads/markRead", { groupId }).catch(() => {
        if (readVisibleTarget.current === target) readVisibleTarget.current = null;
      });
      return;
    }
    void rpc("threads/markRead", { botId: botId! }).catch(() => {
      if (readVisibleTarget.current === target) readVisibleTarget.current = null;
    });
  }, [botId, groupId, navigation]);

  useEffect(() => {
    if (!notificationThreadId || AppState.currentState !== "active" || !navigation.isFocused())
      return;
    void setOpenNotificationThread({ botId, threadId: notificationThreadId }).catch(
      () => undefined,
    );
    void dismissThreadNotifications({ threadId: notificationThreadId }).catch(() => undefined);
  }, [botId, navigation, notificationThreadId]);

  // Cancel delayed setup only when leaving this bot's thread (unmount or botId
  // change). Blur alone is not leave — settings/computer push must keep the timer.
  useEffect(() => {
    if (!botId) return;
    return () => {
      cancelFocusPrompt(botId);
    };
  }, [botId]);

  // Covers returning from a pushed screen; the AppState listener covers returning from background.
  useFocusEffect(
    useCallback(() => {
      if (botId) {
        focusPromptThreadActive(botId);
        void saveLastBotId(botId).catch(() => undefined);
      } else {
        // Group thread focus: prior bot screen may stay mounted, so clear any delayed setup.
        cancelFocusPrompt();
      }
      if (AppState.currentState === "active" && notificationThreadId) {
        void setOpenNotificationThread({
          botId,
          threadId: notificationThreadId,
        }).catch(() => undefined);
      }
      void refreshMentionBots();
      markReadIfVisible();
      speakFinishedReply();
      return () => {
        void setOpenNotificationThread(null).catch(() => undefined);
      };
    }, [botId, markReadIfVisible, notificationThreadId, refreshMentionBots, speakFinishedReply]),
  );

  useEffect(() => {
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        if (!navigation.isFocused() || !notificationThreadId) return;
        void setOpenNotificationThread({
          botId,
          threadId: notificationThreadId,
        }).catch(() => undefined);
        markReadIfVisible();
        return;
      }
      void setOpenNotificationThread(null).catch(() => undefined);
    });
    return () => appState.remove();
  }, [botId, markReadIfVisible, navigation, notificationThreadId]);

  useEffect(() => {
    if (!botId && !groupId) return;
    if (!messageId) {
      pinnedAroundRef.current = null;
      jumpScrollTarget.current = null;
      jumpAnchor.current.release();
    }
    expandedHistoryThread.current = null;
    historyEpoch.current += 1;
    const abort = new AbortController();
    const subscriptionGeneration = ++liveSubscriptionGeneration.current;
    liveSubscribed.current = false;
    void (async () => {
      // Pending search jumps load the around-page separately; avoid replacing it with latest.
      const next = messageId
        ? await rpc<MobileSnapshot>("threads/get", groupId ? { groupId } : { botId: botId! }).catch(
            (err: unknown) => {
              setError(errorText(err));
              return null;
            },
          )
        : await refresh().catch((err: unknown) => {
            setError(errorText(err));
            return null;
          });
      if (abort.signal.aborted) return;
      let cursor = next?.cursor ?? -1;
      let retryMs = 250;
      while (!abort.signal.aborted) {
        try {
          liveSubscribed.current = true;
          await subscribeThread(
            groupId ? { groupId } : { botId: botId! },
            cursor,
            (event) => {
              cursor = Math.max(cursor, event.seq ?? -1);
              retryMs = 250;
              if (
                event.type === "thread.progress" ||
                event.type === "agent.tool.called" ||
                event.type === "agent.tool.completed" ||
                event.type === "thread.message.created" ||
                event.type === "thread.message.updated" ||
                event.type === "thread.message.reaction" ||
                event.type === "thread.subagent" ||
                event.type === "thread.cloud_agent" ||
                event.type === "thread.cleared" ||
                event.type === "run.waiting_input" ||
                event.type === "computer.takeover.requested" ||
                isRunTerminalEvent(event)
              ) {
                if (event.type === "thread.cleared") {
                  expandedHistoryThread.current = null;
                  pinnedAroundRef.current = null;
                  jumpScrollTarget.current = null;
                  jumpAnchor.current.release();
                  historyEpoch.current += 1;
                }
                commitSnap(applyMobileThreadEvent(snapRef.current, event));
              }
              if (event.type === "bot.updated") {
                void refreshMentionBots();
              }
              if (event.type === "thread.message.created" && event.payload?.role === "bot") {
                readVisibleTarget.current = null;
                markReadIfVisible();
              }
              if (isRunTerminalEvent(event)) {
                void refreshMentionBots();
                if (!jumpScrollTarget.current && !expandedHistoryThread.current) {
                  void refresh().catch(() => undefined);
                }
              }
            },
            abort.signal,
          );
        } catch {
          // A full refresh reconciles visible state; the event cursor still resumes without gaps.
        } finally {
          if (liveSubscriptionGeneration.current === subscriptionGeneration) {
            liveSubscribed.current = false;
          }
        }
        if (abort.signal.aborted) break;
        if (!jumpScrollTarget.current && !expandedHistoryThread.current) {
          await refresh().catch(() => undefined);
        }
        await abortableDelay(retryMs, abort.signal);
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    })();
    return () => {
      abort.abort();
    };
  }, [botId, groupId, markReadIfVisible, refreshMentionBots]);

  useEffect(() => {
    if (!botId && !groupId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshDelay = () =>
      threadRefreshDelayMs(snap?.run?.status, { liveSubscribed: liveSubscribed.current });
    const tick = async () => {
      if (
        AppState.currentState === "active" &&
        navigation.isFocused() &&
        !jumpScrollTarget.current &&
        !expandedHistoryThread.current
      ) {
        await refresh().catch(() => undefined);
      }
      if (!cancelled) {
        timer = setTimeout(() => void tick(), refreshDelay());
      }
    };
    timer = setTimeout(() => void tick(), refreshDelay());
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [botId, groupId, navigation, snap?.run?.status]);

  useEffect(() => {
    if (!botId && !groupId) return;
    // A conversation hit is the thread itself: stay on the live tail, not an older page.
    if (!messageId) {
      const pinned = pinnedAroundRef.current != null || jumpAnchor.current.holds();
      jumpAnchor.current.release();
      jumpScrollTarget.current = null;
      pinnedAroundRef.current = null;
      if (pinned) {
        expandedHistoryThread.current = null;
        commitSnap(snapRef.current);
      }
      return;
    }
    jumpAnchor.current.begin(messageId);
    void applyMessageJump(groupId ? { groupId, messageId } : { botId: botId!, messageId }).catch(
      (err) => {
        setError(errorText(err, t("Could not open message")));
      },
    );
  }, [botId, groupId, messageId]);

  useEffect(() => {
    setPendingAttachments((current) => attachmentsForThread(current, threadKey));
    setDraft("");
    setMentionQuery(null);
    setSlashQuery(null);
    setSelectedSkill(null);
    setSelectedMentions([]);
    setReplyTarget(null);
    setReplyQuote(null);
    setQuoteTarget(null);
    setAttachmentNotice(null);
    setError(null);
  }, [threadKey]);

  function updateDraft(value: string) {
    setDraft(value);
    const match = /(?:^|\s)@([\w-]*)$/.exec(value);
    setMentionQuery(match ? (match[1] ?? "") : null);
    const slashMatch = selectedSkill === null ? /^\/([^\n]*)$/.exec(value) : null;
    setSlashQuery(slashMatch ? (slashMatch[1] ?? "") : null);
  }

  function insertMention(mention: ComposerMention) {
    setDraft((current) => current.replace(/@([\w-]*)$/, ""));
    setMentionQuery(null);
    setSelectedMentions((current) =>
      current.some((selected) => mentionChipKey(selected) === mentionChipKey(mention))
        ? current
        : [...current, mention],
    );
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    setSelectedSkill(skill);
    setDraft("");
    setSlashQuery(null);
  }

  function removeLastChip() {
    if (selectedMentions.length > 0) {
      setSelectedMentions((current) => current.slice(0, -1));
      return;
    }
    if (selectedSkill) setSelectedSkill(null);
  }

  function serializeComposerPromptText(): string {
    return serializeComposerPrompt(draft, selectedSkill, selectedMentions);
  }

  function runSlashAction(action: SlashActionId) {
    setDraft("");
    setSlashQuery(null);
    if (action === "chat-settings") {
      if (inGroup && groupId) {
        router.push({ pathname: "/group-settings", params: { groupId } });
      } else if (botId) {
        router.push({ pathname: "/bot-settings", params: { botId } });
      }
      return;
    }
    router.push({
      pathname: "/account",
      params: action === "settings-usage" ? { focus: "usage" } : undefined,
    });
  }

  const composerPillStyle = {
    width: 36,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  } as const;

  const canSend =
    Boolean(draft.trim()) ||
    selectedSkill !== null ||
    selectedMentions.length > 0 ||
    activePendingAttachments.length > 0;

  async function send() {
    const initialBotTarget = botId;
    const initialGroupTarget = groupId;
    if ((!initialBotTarget && !initialGroupTarget) || sending) return;
    const originThreadKey = initialGroupTarget ?? initialBotTarget;
    const attachments = attachmentsForThread(pendingAttachments, originThreadKey);
    const plan = resolveComposerSendPlan({
      text: serializeComposerPromptText(),
      mentions: selectedMentions,
      hasAttachments: attachments.length > 0,
    });
    if (plan.isNoOp) return;
    const reroutedToGroup = Boolean(
      plan.rerouteGroupId && plan.rerouteGroupId !== initialGroupTarget,
    );
    const groupTarget = plan.rerouteGroupId ?? initialGroupTarget;
    const botTarget = reroutedToGroup ? undefined : initialBotTarget;
    const trimmed = plan.trimmed;
    const dropDelayedSetup = () => {
      // Only after successful engagement so a failed upload/send keeps the setup card.
      // Covers group-mention reroute while the bot thread stays mounted underneath.
      if (initialBotTarget) cancelFocusPrompt(initialBotTarget);
    };
    setSending(true);
    setError(null);
    try {
      if (plan.shouldRunRoutines) {
        const sendNonce = newClientNonce();
        await Promise.all(
          plan.routineIds.map((routineId) =>
            rpc("routines/testRun", {
              routineId,
              clientNonce: `routine-mention:${sendNonce}:${routineId}`,
            }),
          ),
        );
      }
      const clearOriginComposer = () => {
        setPendingAttachments((current) =>
          current.filter((attachment) => attachment.threadKey !== originThreadKey),
        );
        setDraft("");
        setMentionQuery(null);
        setSlashQuery(null);
        setSelectedSkill(null);
        setSelectedMentions([]);
        setReplyTarget(null);
        setReplyQuote(null);
        setAttachmentNotice(null);
      };
      if (!plan.shouldSend) {
        dropDelayedSetup();
        clearOriginComposer();
        if (reroutedToGroup && groupTarget) {
          router.push({
            pathname: "/group-thread",
            params: {
              groupId: groupTarget,
              name: plan.rerouteGroupName ?? t("Group"),
            },
          });
          return;
        }
        if (isCurrentTarget(botTarget, groupTarget)) {
          await refresh();
        }
        return;
      }
      const artifactIds: string[] = [];
      for (const pending of attachments) {
        const artifact = await rpc<{ id: string }>("artifacts/create", {
          ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
          name: pending.name,
          mimeType: pending.mimeType,
          contentBase64: pending.contentBase64,
        });
        artifactIds.push(artifact.id);
      }
      const clientNonce = newClientNonce();
      await rpc(
        "threads/send",
        groupTarget
          ? {
              groupId: groupTarget,
              clientNonce,
              text: trimmed || undefined,
              mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
              artifactIds: artifactIds.length ? artifactIds : undefined,
              replyToMessageId: reroutedToGroup ? undefined : replyTarget?.id,
              replyQuote: reroutedToGroup ? undefined : (replyQuote ?? undefined),
            }
          : {
              botId: botTarget!,
              clientNonce,
              text: trimmed || undefined,
              mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
              artifactIds: artifactIds.length ? artifactIds : undefined,
              replyToMessageId: replyTarget?.id,
              replyQuote: replyQuote ?? undefined,
            },
      );
      dropDelayedSetup();
      void loadSessionToken()
        .then((token) => resumeLiveNotifications(currentApiBase(), token, selectedSpaceId() ?? ""))
        .catch(() => undefined);
      clearOriginComposer();
      if (reroutedToGroup && groupTarget) {
        router.push({
          pathname: "/group-thread",
          params: {
            groupId: groupTarget,
            name: plan.rerouteGroupName ?? t("Group"),
          },
        });
        return;
      }
      if (isCurrentTarget(botTarget, groupTarget)) {
        // A sent message lands at the latest end, past an older page opened from search.
        if (pinnedAroundRef.current) showLatest();
        void refresh().catch(() => undefined);
      }
    } catch (err) {
      if (reroutedToGroup && groupTarget) {
        setError(errorText(err, t("Failed to send message")));
      } else if (isCurrentTarget(botTarget, groupTarget)) {
        setError(errorText(err, t("Failed to send message")));
      }
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    const targetBotId = botId;
    const targetGroupId = groupId;
    if ((!targetBotId && !targetGroupId) || sending) return;
    setSending(true);
    setError(null);
    try {
      await rpc(
        "threads/stop",
        targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! },
      );
    } catch (err) {
      if (isCurrentTarget(targetBotId, targetGroupId)) {
        setError(errorText(err, t("Failed to stop work")));
      }
      setSending(false);
      return;
    }
    try {
      await refresh();
    } catch (err) {
      if (isCurrentTarget(targetBotId, targetGroupId)) {
        const detail = errorText(err, t("Failed to refresh"));
        setError(t("Work stopped, but the thread could not refresh: {detail}", { detail }));
      }
    } finally {
      setSending(false);
    }
  }

  const answerMessage = useCallback(
    async (message: MobileMessage, answer: string, username?: string) => {
      const targetBotId = botId;
      const targetGroupId = groupId;
      if ((!targetBotId && !targetGroupId) || !message.runId) return;
      await rpc("threads/answer", {
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        runId: message.runId,
        messageId: message.id,
        answer,
        ...(username ? { username } : {}),
      });
      if (isCurrentTarget(targetBotId, targetGroupId)) await refresh();
    },
    [botId, groupId],
  );

  const openBot = useCallback(
    (id: string, botName: string) =>
      router.push({ pathname: "/thread", params: { botId: id, name: botName } }),
    [router],
  );

  const openComputer = useCallback(
    (id: string, botName: string) =>
      router.push({ pathname: "/computer", params: { botId: id, name: botName } }),
    [router],
  );

  const speak = useCallback(
    (message: MobileMessage) => {
      const startIndex = visibleMessages.findIndex((candidate) => candidate.id === message.id);
      const fromHere = startIndex === -1 ? [message] : visibleMessages.slice(startIndex);
      const items = fromHere.flatMap((candidate) => {
        if (candidate.role !== "bot") return [];
        const text = speakableMessageText(candidate);
        if (!text) return [];
        const speakerBotId = candidate.botId ?? botId ?? snap?.members?.[0]?.botId ?? "";
        return [
          {
            text,
            botId: speakerBotId,
            messageId: candidate.id,
            speaker: {
              name: memberName(snap?.members, speakerBotId) ?? displayName,
              color: speakerColorFor(mentionBots, snap?.members, speakerBotId),
            },
          },
        ];
      });
      if (items.length === 0) return;
      void speakQueue(items)
        .then((spoken) => {
          if (!spoken)
            Alert.alert(t("Could not speak"), t("Add a voice provider in Voice settings."));
        })
        .catch((err: unknown) =>
          Alert.alert(t("Could not speak"), errorText(err, t("Try again."))),
        );
    },
    [botId, displayName, mentionBots, snap?.members, visibleMessages],
  );

  async function startVoiceCall() {
    const targetBotId = botId;
    if (!targetBotId || voiceCallStarting.current) return;
    voiceCallStarting.current = true;
    const loadVoiceStatus = () => rpc<{ ready: boolean; transcribe: boolean }>("voice/status");
    try {
      const plan = await resolveVoiceCallPlan({
        loadDeviceVoiceEnabled,
        dictationAvailable,
        loadVoiceStatus,
      });
      if (activeBotId.current !== targetBotId) return;
      if (plan.kind === "settings") {
        router.push("/voice");
        return;
      }
      if (plan.kind === "dictation") {
        Alert.alert(
          t("Calls need transcription"),
          t("Allow speech recognition in Settings, or connect ElevenLabs, OpenAI, or Fish Audio."),
          [
            { text: t("Not now"), style: "cancel" },
            { text: t("Open Voice"), onPress: () => router.push("/voice") },
          ],
        );
        return;
      }
      const startedCallId = startCall({
        botId: targetBotId,
        botName: displayName ?? t("Bot"),
        botColor: mentionBots.find((bot) => bot.id === targetBotId)?.color,
        transcribe: plan.transcribe,
      });
      if (plan.kind === "device") {
        void probeProviderTranscribe(loadVoiceStatus)
          .then((enabled) => {
            if (enabled) setCallProviderTranscribe(true, startedCallId);
          })
          .catch(() => undefined);
      }
    } catch {
      if (activeBotId.current === targetBotId) router.push("/voice");
    } finally {
      voiceCallStarting.current = false;
    }
  }

  const attachActions: MenuAction[] = [
    { id: "library", title: t("Photo library"), image: "photo.on.rectangle" },
    { id: "camera", title: t("Camera"), image: "camera" },
    { id: "file", title: t("File"), image: "doc" },
  ];

  function attachFrom(source: string) {
    if (source === "library") void addAttachments(pickFromLibrary);
    else if (source === "camera") void addAttachments(takePhoto);
    else if (source === "file") void addAttachments(pickDocuments);
  }

  async function addAttachments(
    picker: (existingCount: number) => Promise<{
      attachments: PickedAttachment[];
      skipped: Array<{ name: string; reason: string }>;
    }>,
  ) {
    const targetKey = groupId ?? botId;
    if (!targetKey) return;
    const result = await picker(activePendingAttachments.length);
    if ((groupId ?? botId) !== targetKey) return;
    if (result.attachments.length) {
      setPendingAttachments((current) => [
        ...current,
        ...result.attachments.map((attachment) => ({
          ...attachment,
          threadKey: targetKey,
        })),
      ]);
    }
    setAttachmentNotice(
      result.skipped.length
        ? t("Skipped {items}", {
            items: result.skipped.map((item) => formatAttachmentSkip(item)).join(", "),
          })
        : null,
    );
  }

  const answerableAskMessageId = latestAnswerableAskMessageId(snap);
  const runError = snap?.run?.status === "failed" ? (snap.run.error ?? null) : null;
  // Group calls in reading order, then reverse for the inverted list.
  const liveItems = useMemo(() => groupVoiceChats(visibleMessages).reverse(), [visibleMessages]);
  const messagesById = useMemo(
    () => new Map((snap?.messages ?? []).map((message) => [message.id, message])),
    [snap?.messages],
  );
  const pinnedTarget = pinnedAroundRef.current;
  const showPinnedPage = Boolean(
    jumpScrollTarget.current ||
      (pinnedTarget &&
        ((pinnedTarget.botId && pinnedTarget.botId === botId) ||
          (pinnedTarget.groupId && pinnedTarget.groupId === groupId))),
  );
  const pinnedNewerCursor = showPinnedPage ? (pinnedTarget?.newerCursor ?? null) : null;

  function performScroll(action: ThreadScrollAction) {
    if (!action || showPinnedPage) return;
    scroll.current?.scrollToOffset({
      offset: 0,
      animated: action === "smooth" && !reducedMotion,
    });
  }

  function pinnedDistanceFromEnd(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    return contentSize.height - layoutMeasurement.height - contentOffset.y;
  }

  function pinnedNearEnd() {
    const { offset, viewport, content } = pinnedScrollMetrics.current;
    return viewport > 0 && content - viewport - offset <= 80;
  }

  function scrollPinnedTo(offset: number) {
    pinnedScroll.current?.scrollTo({ y: offset, animated: false });
    pinnedScrollMetrics.current.offset = offset;
  }

  function loadNewerNearEnd() {
    // Wait until the matched row has a real offset. Prefetching from the top
    // of the page changes the content size and lands back on an older reply.
    // A hit that is not drawn (filtered out of the transcript) must not hold
    // that wait, or newer pages never load.
    const targetId = jumpScrollTarget.current ?? pinnedAroundRef.current?.messageId;
    const targetDrawn =
      targetId != null &&
      threadWindowMessages(visibleMessages, pinnedNewerCursor).some(
        (message) => message.id === targetId,
      );
    if (jumpAnchor.current.holds() && !targetDrawn) {
      jumpAnchor.current.release();
      jumpScrollTarget.current = null;
    } else if (jumpAnchor.current.blocksPaging(targetDrawn, headerHeight + 24)) {
      return;
    }
    const { offset, viewport, content } = pinnedScrollMetrics.current;
    // Fetch the next page while a screen of this one is still left to read; a page shorter
    // than the screen never scrolls, so layout and content changes check too.
    if (viewport > 0 && content - viewport - offset < viewport) void loadNewerMessages();
  }

  function updatePinnedScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    // Once the page reaches the latest message, the end of it is the live thread.
    if (
      pinnedNewerCursor === null &&
      !jumpScrollTarget.current &&
      pinnedDistanceFromEnd(event) <= 80
    ) {
      showLatest();
    }
  }

  function updateUserScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    // Inverted FlatList: contentOffset.y is distance from the latest messages.
    setThreadScrollState(
      scrollBehavior.current.onUserScroll(Math.max(0, event.nativeEvent.contentOffset.y)),
    );
  }

  async function reactToMessage(message: MobileMessage, reaction: MessageReaction) {
    const targetBotId = botId;
    const targetGroupId = groupId;
    if (!targetBotId && !targetGroupId) return;
    try {
      await rpc("threads/react", {
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        messageId: message.id,
        reaction,
        clientNonce: newClientNonce(),
      });
    } catch (err) {
      if (!isCurrentTarget(targetBotId, targetGroupId)) return;
      setError(errorText(err, t("Could not update reaction")));
    }
  }

  function messageActionProps(message: MobileMessage): {
    actionProps: MessageActionProps;
    menu: ReturnType<typeof buildMessageContextMenu>;
    onMenuAction: (id: string) => void;
  } {
    const messageText = selectableMobileMessageText(message);
    const includeQuote =
      !message.id.startsWith("progress:") &&
      quotableMessageSegments(message.role, message.blocks).length > 0;
    const includeReact = canReactToThreadMessage(message);
    // The call already reads replies aloud; a second voice would talk over it.
    const includeSpeak = message.role === "bot" && !onCall && Boolean(blockText(message));
    const includeSelect = messageText.trim().length > 0;
    const reply = () => {
      setReplyTarget(message);
      setReplyQuote(null);
    };
    const quote = () => setQuoteTarget(message);
    const speakMessage = () => void speak(message);
    const select = () =>
      setSelectableText(
        message.role === "user" ? messageText : selectableTextFromMarkdown(messageText),
      );
    const copy = () => {
      const text = copyableMobileMessageText(message);
      if (text) void Clipboard.setStringAsync(text).catch(() => undefined);
    };
    const react = (reaction: MessageReaction) => void reactToMessage(message, reaction);
    const actions = [
      { name: "reply", text: t("Reply"), onPress: reply },
      ...(includeQuote ? [{ name: "quote", text: t("Quote"), onPress: quote }] : []),
      ...(includeReact
        ? [
            {
              name: "react",
              text: t("React"),
              onPress: () =>
                presentMessageActionSheet({
                  cancel: t("Cancel"),
                  more: t("More"),
                  colorScheme,
                  actions: MESSAGE_REACTIONS.map((emoji) => ({
                    text: emoji,
                    onPress: () => react(emoji),
                  })),
                }),
            },
          ]
        : []),
      ...(includeSpeak ? [{ name: "speak", text: t("Speak message"), onPress: speakMessage }] : []),
      ...(includeSelect ? [{ name: "select", text: t("Select text"), onPress: select }] : []),
      { name: "copy", text: t("Copy"), onPress: copy },
    ];
    const menu = buildMessageContextMenu({
      labels: {
        reply: t("Reply"),
        copy: t("Copy"),
        react: t("React"),
        quote: t("Quote"),
        speak: t("Speak message"),
        select: t("Select text"),
      },
      reactions: MESSAGE_REACTIONS,
      include: {
        quote: includeQuote,
        react: includeReact,
        speak: includeSpeak,
        select: includeSelect,
      },
    });
    const openSheet = () =>
      presentMessageActionSheet({
        actions,
        title: message.createdAt
          ? formatMessageTime(message.createdAt, dateLocaleForUi())
          : undefined,
        cancel: t("Cancel"),
        more: t("More"),
        colorScheme,
      });
    return {
      menu,
      onMenuAction: (id) => {
        const reaction = messageMenuReaction(id);
        if (reaction && (MESSAGE_REACTIONS as readonly string[]).includes(reaction)) {
          react(reaction as MessageReaction);
          return;
        }
        if (id === "reply") reply();
        if (id === "copy") copy();
        if (id === "quote") quote();
        if (id === "speak") speakMessage();
        if (id === "select") select();
      },
      actionProps: {
        onLongPress: Platform.OS === "ios" ? undefined : openSheet,
        accessibilityActions: actions.map((action) => ({ name: action.name, label: action.text })),
        onAccessibilityAction: (event) => {
          actions.find((action) => action.name === event.nativeEvent.actionName)?.onPress();
        },
      },
    };
  }

  function renderMessageRow(
    message: MobileMessage,
    options?: { enableJump?: boolean; index?: number },
  ) {
    const { actionProps, menu, onMenuAction } = messageActionProps(message);
    const messageReactions = reactionView.reactions.get(message.id);
    const activityBotId =
      !inGroup && message.role === "bot" && message.id.startsWith("progress:")
        ? (message.botId ?? botId)
        : undefined;
    const activityBot = activityBotId
      ? (snap?.members?.find((member) => member.botId === activityBotId) ??
        (currentBot?.id === activityBotId ? currentBot : undefined))
      : undefined;
    const activityStatus = activityBotId
      ? (snap?.activeRuns?.find((run) => run.botId === activityBotId)?.status ??
        (snap?.run?.botId === activityBotId ? snap.run.status : currentBotStatus))
      : undefined;
    return (
      <View
        key={message.id}
        onLayout={
          options?.enableJump
            ? (event) => {
                // Opaque header used to own this space; clear the transparent bar + fade.
                const offset = jumpAnchor.current.onMessageLayout(
                  message.id,
                  event.nativeEvent.layout.y,
                  options.index ?? 0,
                  headerHeight + 24,
                );
                if (offset == null) return;
                scrollPinnedTo(offset);
                requestAnimationFrame(() => {
                  const again = jumpAnchor.current.align(headerHeight + 24);
                  if (again != null) scrollPinnedTo(again);
                });
              }
            : undefined
        }
        style={{
          marginTop: 12,
          width: "100%",
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 8,
          justifyContent: message.role === "user" ? "flex-end" : "flex-start",
        }}
      >
        {activityBotId ? (
          <View style={{ paddingTop: 22 }}>
            <BotAvatar
              color={activityBot?.color ?? tokens.mutedForeground}
              identity={activityBotId}
              size={inGroup ? 20 : 28}
              status={activityStatus}
            />
          </View>
        ) : null}
        <View
          style={{
            width: isCenteredAgentEvent(message.blocks) ? "100%" : undefined,
            maxWidth: isCenteredAgentEvent(message.blocks)
              ? "100%"
              : activityBotId
                ? undefined
                : "90%",
            flex: activityBotId ? 1 : undefined,
            flexShrink: 1,
          }}
        >
          <MessageContextMenu
            actions={menu}
            colorScheme={colorScheme}
            onAction={onMenuAction}
            onLongPress={actionProps.onLongPress}
          >
            <MessageBubble
              botId={botId ?? snap?.members?.[0]?.botId ?? ""}
              groupId={groupId}
              message={message}
              botName={displayName}
              bots={mentionBots}
              members={snap?.members}
              replyPreview={
                message.replyToMessageId ? messagesById.get(message.replyToMessageId) : undefined
              }
              canAnswer={message.id === answerableAskMessageId}
              onAnswer={answerMessage}
              onOpenBot={openBot}
              onOpenComputer={openComputer}
              onChoiceDismissed={(question) => {
                setDismissedChoiceQuestions((current) => {
                  const existing = current.get(message.id);
                  if (existing?.has(question)) return current;
                  const next = new Map(current);
                  const questions = new Set(existing);
                  questions.add(question);
                  next.set(message.id, questions);
                  return next;
                });
              }}
              onPreviewMarkdown={setMarkdownPreview}
              onPreviewImage={(target) =>
                router.push({
                  pathname: "/image",
                  params: { ...target, ...(groupId ? { groupId } : { botId }) },
                })
              }
              actionProps={actionProps}
            />
          </MessageContextMenu>
          {messageReactions ? (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: 4,
                marginTop: 4,
                justifyContent: message.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              {[...messageReactions].map(([emoji, count]) => (
                <Text
                  key={emoji}
                  style={{
                    color: tokens.foreground,
                    backgroundColor: tokens.muted,
                    borderColor: tokens.border,
                    borderWidth: 1,
                    borderRadius: 16,
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    fontSize: 13,
                  }}
                >
                  {emoji}
                  {count > 1 ? ` ${count}` : ""}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  const workingFooter =
    !inGroup && currentBot && isWorkingStatus(currentBotStatus) && !hasLiveProgress ? (
      <View
        accessibilityLabel={t("{name} is working", { name: currentBot.name })}
        accessibilityRole="text"
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 40,
          marginTop: 12,
        }}
      >
        <BotAvatar
          color={currentBot.color}
          identity={currentBot.id}
          size={28}
          status={currentBotStatus}
        />
        <WorkingIndicator />
      </View>
    ) : inGroup && workingGroupBots.length > 0 ? (
      <View
        accessibilityLabel={
          workingGroupBots.length === 1
            ? t("{name} is working", { name: workingGroupBots[0]?.name ?? t("Agent") })
            : t("{count} agents working", { count: workingGroupBots.length })
        }
        accessibilityRole="text"
        style={{
          flexDirection: "row",
          alignItems: "center",
          minHeight: 40,
          marginTop: 12,
        }}
      >
        <View style={{ flexDirection: "row", paddingRight: 8 }}>
          {workingGroupBots.map((bot, index) => (
            <View
              key={bot.botId}
              style={{
                marginLeft: index === 0 ? 0 : -8,
                zIndex: workingGroupBots.length - index,
              }}
            >
              <BotAvatar color={bot.color} identity={bot.botId} size={28} status={bot.status} />
            </View>
          ))}
        </View>
        <WorkingIndicator />
      </View>
    ) : null;

  const loadEarlierControl =
    snap?.olderCursor != null ? (
      <Pressable
        disabled={loadingOlder}
        onPress={() => void loadOlderMessages()}
        style={{
          alignSelf: "center",
          paddingHorizontal: 12,
          paddingVertical: 10,
        }}
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
          {loadingOlder ? t("Loading…") : t("Load earlier messages")}
        </Text>
      </Pressable>
    ) : null;

  return (
    <KeyboardAvoidingView
      behavior="height"
      keyboardVerticalOffset={0}
      style={{ flex: 1, backgroundColor: tokens.background, paddingHorizontal: 20 }}
    >
      {error ? (
        <Text style={{ color: tokens.mutedForeground, marginTop: headerHeight + 28 }}>{error}</Text>
      ) : null}
      {runError ? (
        <Text style={{ color: tokens.destructive, marginTop: error ? 12 : headerHeight + 28 }}>
          {runError}
        </Text>
      ) : null}
      {/* The floor keeps a tall suggestion list from sliding under the transparent header. */}
      <View style={{ flex: 1, minHeight: headerHeight, position: "relative" }}>
        {showPinnedPage ? (
          <ScrollView
            key={jumpScrollTarget.current ?? pinnedTarget?.messageId ?? threadKey}
            ref={pinnedScroll}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingTop: headerHeight + 8, paddingBottom: 16 }}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            scrollEventThrottle={16}
            onLayout={(event) => {
              pinnedScrollMetrics.current.viewport = event.nativeEvent.layout.height;
              loadNewerNearEnd();
            }}
            onContentSizeChange={(_, height) => {
              pinnedScrollMetrics.current.content = height;
              const jumpOffset = jumpAnchor.current.align(headerHeight + 24);
              if (jumpOffset != null) scrollPinnedTo(jumpOffset);
              const armedAt = joinPinnedAfterLayout.current;
              if (armedAt != null && height !== armedAt) {
                joinPinnedAfterLayout.current = null;
                if (
                  !jumpAnchor.current.holds() &&
                  pinnedAroundRef.current?.newerCursor == null &&
                  pinnedNearEnd()
                ) {
                  showLatest();
                  return;
                }
              }
              loadNewerNearEnd();
            }}
            onScroll={(event) => {
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
              pinnedScrollMetrics.current = {
                offset: contentOffset.y,
                viewport: layoutMeasurement.height,
                content: contentSize.height,
              };
              loadNewerNearEnd();
            }}
            onScrollBeginDrag={() => {
              newerLoadFailed.current = false;
              if (!jumpAnchor.current.holds()) return;
              jumpAnchor.current.release();
              jumpScrollTarget.current = null;
            }}
            onScrollEndDrag={updatePinnedScroll}
            onMomentumScrollEnd={updatePinnedScroll}
          >
            {loadEarlierControl}
            {threadWindowMessages(visibleMessages, pinnedNewerCursor).map((message, index) =>
              renderMessageRow(message, { enableJump: true, index }),
            )}
            {pinnedNewerCursor === null ? (
              workingFooter
            ) : loadingNewer ? (
              <ActivityIndicator color={tokens.mutedForeground} style={{ marginVertical: 12 }} />
            ) : null}
          </ScrollView>
        ) : (
          <FlatList
            key={threadKey}
            ref={scroll}
            data={liveItems}
            inverted
            keyExtractor={(item) => (item.kind === "voiceChat" ? item.key : item.message.id)}
            extraData={answerableAskMessageId}
            style={{ flex: 1 }}
            // Inverted, so the bottom padding is the visual top, clear of the transparent header.
            contentContainerStyle={{ paddingBottom: headerHeight + 8, paddingTop: 16 }}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            scrollEventThrottle={16}
            onScrollBeginDrag={() => {
              userDragging.current = true;
            }}
            onScroll={(event) => {
              if (userDragging.current) updateUserScroll(event);
            }}
            onScrollEndDrag={(event) => {
              updateUserScroll(event);
              userDragging.current = false;
            }}
            onMomentumScrollEnd={updateUserScroll}
            onLayout={() => performScroll(scrollBehavior.current.onLayout())}
            onContentSizeChange={() => {
              if (loadingOlderContent.current) {
                loadingOlderContent.current = false;
                return;
              }
              const blocked = Boolean(
                jumpScrollTarget.current ||
                  (pinnedAroundRef.current &&
                    ((pinnedAroundRef.current.botId && pinnedAroundRef.current.botId === botId) ||
                      (pinnedAroundRef.current.groupId &&
                        pinnedAroundRef.current.groupId === groupId))) ||
                  expandedHistoryThread.current === snap?.threadId,
              );
              performScroll(scrollBehavior.current.onContentChanged(blocked, latestMessageId));
              setThreadScrollState(scrollBehavior.current.state());
            }}
            ListFooterComponent={loadEarlierControl}
            ListHeaderComponent={workingFooter}
            renderItem={({ item }) =>
              item.kind === "voiceChat" ? (
                <View style={{ marginTop: 12, width: "100%" }}>
                  <VoiceChatCard group={item} />
                </View>
              ) : (
                renderMessageRow(item.message)
              )
            }
          />
        )}
        {showPinnedPage || threadScrollState.detached ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              threadScrollState.unread ? t("Jump to latest, new messages") : t("Jump to latest")
            }
            onPress={() => {
              if (showPinnedPage) {
                showLatest();
                return;
              }
              performScroll(scrollBehavior.current.jumpToLatest());
              setThreadScrollState(scrollBehavior.current.state());
            }}
            style={{
              position: "absolute",
              left: "50%",
              marginLeft: -21,
              bottom: 12,
              width: 42,
              height: 42,
            }}
          >
            <GlassSurface
              shape="circle"
              style={styles.circleButton}
              fallbackStyle={{
                borderWidth: 1,
                borderColor: native.fillPressed,
                backgroundColor: native.fill,
              }}
            >
              <NativeSymbol
                ios="arrow.down"
                android="arrow-down"
                size={18}
                color={tokens.foreground}
              />
              {threadScrollState.unread ? (
                <View
                  style={{
                    position: "absolute",
                    top: 3,
                    right: 3,
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: tokens.primary,
                  }}
                />
              ) : null}
            </GlassSurface>
          </Pressable>
        ) : null}
      </View>
      {/* Fades messages out under the transparent header; the alpha stop keeps the page hue. */}
      <View pointerEvents="none" style={[styles.headerFade, { height: headerHeight + 24 }]} />
      {/* Shrinks (the suggestion lists scroll) so the input and Send stay above the keyboard. */}
      <View
        style={{
          flexShrink: 1,
          paddingBottom: keyboardVisible ? 12 : Math.max(insets.bottom + 12, 24),
        }}
      >
        {/* Fades messages out above the composer, like the header fade. */}
        <View pointerEvents="none" style={styles.composerFade} />
        {replyTarget ? (
          <GlassSurface
            style={{
              marginTop: 12,
              borderRadius: 999,
              paddingStart: 16,
              paddingEnd: 10,
              paddingVertical: 8,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
            }}
            fallbackStyle={{
              borderRadius: 14,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.card,
              paddingStart: 12,
              paddingEnd: 12,
              paddingVertical: 10,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                {t("Replying to")}
              </Text>
              <Text style={{ color: tokens.foreground, fontSize: 13 }} numberOfLines={1}>
                {replyQuote ? `“${replyQuote}”` : previewMessageText(replyTarget)}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Cancel reply")}
              hitSlop={8}
              onPress={() => {
                setReplyTarget(null);
                setReplyQuote(null);
              }}
            >
              <NativeSymbol
                ios="xmark.circle.fill"
                android="close-circle"
                size={20}
                color={tokens.mutedForeground}
              />
            </Pressable>
          </GlassSurface>
        ) : null}
        {attachmentNotice ? (
          <Text style={{ color: tokens.warning, marginTop: 12, fontSize: 13 }}>
            {attachmentNotice}
          </Text>
        ) : null}
        {activePendingAttachments.length ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 8,
              marginTop: 12,
            }}
          >
            {activePendingAttachments.map((attachment) => (
              <View
                key={attachment.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: tokens.border,
                  backgroundColor: tokens.card,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                }}
              >
                {attachment.previewUri ? (
                  <Image
                    source={{ uri: attachment.previewUri }}
                    style={{ width: 28, height: 28, borderRadius: 6 }}
                  />
                ) : (
                  <NativeSymbol
                    ios="paperclip"
                    android="attach"
                    size={16}
                    color={tokens.mutedForeground}
                  />
                )}
                <Text style={{ color: tokens.foreground, maxWidth: 140 }} numberOfLines={1}>
                  {attachment.name}
                </Text>
                <Pressable
                  accessibilityLabel={t("Remove {name}", { name: attachment.name })}
                  onPress={() =>
                    setPendingAttachments((current) =>
                      current.filter((item) => item.id !== attachment.id),
                    )
                  }
                >
                  <NativeSymbol
                    ios="xmark"
                    android="close"
                    size={14}
                    color={tokens.mutedForeground}
                  />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        {mentionOptions.length ? (
          <ScrollView
            testID="mention-picker"
            keyboardShouldPersistTaps="handled"
            style={{
              flexGrow: 0,
              flexShrink: 1,
              marginTop: 12,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.card,
              overflow: "hidden",
            }}
          >
            {mentionOptions.map((mention) => (
              <Pressable
                key={mentionChipKey(mention)}
                accessibilityLabel={t("@{name}", { name: mention.name })}
                onPress={() => insertMention(mention)}
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: 10,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}
              >
                <MentionOptionIcon mention={mention} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: tokens.foreground, fontSize: 14 }}>@{mention.name}</Text>
                  {mention.subtitle ? (
                    <Text
                      numberOfLines={1}
                      style={{
                        color: tokens.mutedForeground,
                        fontSize: 12.5,
                        marginTop: 2,
                      }}
                    >
                      {mention.subtitle}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        {slashSkillOptions.length || slashActionOptions.length ? (
          <ScrollView
            testID="slash-picker"
            keyboardShouldPersistTaps="handled"
            style={{
              flexGrow: 0,
              flexShrink: 1,
              marginTop: 12,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.card,
              overflow: "hidden",
            }}
          >
            {slashSkillOptions.map((skill) => (
              <Pressable
                key={skill.id}
                accessibilityLabel={t("Skill {name}", { name: skill.name })}
                onPress={() => insertSkill(skill)}
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: 10,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}
              >
                <NativeSymbol
                  ios="cube"
                  android="cube-outline"
                  size={16}
                  color={tokens.mutedForeground}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: tokens.foreground, fontSize: 14 }}>{skill.name}</Text>
                  <Text
                    numberOfLines={1}
                    style={{ color: tokens.mutedForeground, fontSize: 12.5, marginTop: 2 }}
                  >
                    {truncateSlashDescription(skill.description)}
                  </Text>
                </View>
              </Pressable>
            ))}
            {slashActionOptions.map((action) => (
              <Pressable
                key={action.id}
                accessibilityLabel={t(action.label)}
                onPress={() => runSlashAction(action.id)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}
              >
                <NativeSymbol
                  ios="gearshape"
                  android="settings-outline"
                  size={16}
                  color={tokens.mutedForeground}
                />
                <Text style={{ color: tokens.foreground, fontSize: 14 }}>{t(action.label)}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10, marginTop: 8 }}>
          <MenuView
            actions={attachActions}
            colorScheme={colorScheme}
            onPressAction={(event) => attachFrom(event.nativeEvent.event)}
          >
            <View
              accessible
              accessibilityRole="button"
              accessibilityLabel={t("Attach file")}
              style={{ width: 44, height: 44 }}
            >
              <GlassSurface
                shape="circle"
                style={styles.circleButton}
                fallbackStyle={styles.composerFill}
              >
                <NativeSymbol ios="plus" android="add" size={18} color={tokens.mutedForeground} />
              </GlassSurface>
            </View>
          </MenuView>
          <GlassSurface
            shape="roundedRectangle"
            style={{
              flex: 1,
              minHeight: 44,
              borderRadius: 22,
              flexDirection: "row",
              alignItems: "flex-end",
              paddingStart: 16,
              paddingEnd: 4,
            }}
            fallbackStyle={styles.composerFill}
          >
            <View
              style={{
                flex: 1,
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 6,
              }}
            >
              {selectedSkill ? (
                <View
                  testID="skill-chip"
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    backgroundColor: tokens.muted,
                    borderRadius: 999,
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                    maxWidth: "100%",
                  }}
                >
                  <NativeSymbol
                    ios="cube"
                    android="cube-outline"
                    size={13}
                    color={tokens.mutedForeground}
                  />
                  <Text
                    numberOfLines={1}
                    style={{ color: tokens.foreground, fontSize: 13, flexShrink: 1 }}
                  >
                    {selectedSkill.name}
                  </Text>
                  <Pressable
                    accessibilityLabel={t("Remove skill {name}", { name: selectedSkill.name })}
                    hitSlop={8}
                    onPress={() => setSelectedSkill(null)}
                  >
                    <NativeSymbol
                      ios="xmark"
                      android="close"
                      size={12}
                      color={tokens.mutedForeground}
                    />
                  </Pressable>
                </View>
              ) : null}
              {selectedMentions.map((mention) => (
                <View
                  key={mentionChipKey(mention)}
                  testID="mention-chip"
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    backgroundColor: tokens.muted,
                    borderRadius: 999,
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                    maxWidth: "100%",
                  }}
                >
                  <MentionChipIcon mention={mention} />
                  <Text
                    numberOfLines={1}
                    style={{ color: tokens.foreground, fontSize: 13, flexShrink: 1 }}
                  >
                    {mention.name}
                  </Text>
                  <Pressable
                    accessibilityLabel={t("Remove mention {name}", { name: mention.name })}
                    hitSlop={8}
                    onPress={() =>
                      setSelectedMentions((current) =>
                        current.filter(
                          (selected) => mentionChipKey(selected) !== mentionChipKey(mention),
                        ),
                      )
                    }
                  >
                    <NativeSymbol
                      ios="xmark"
                      android="close"
                      size={12}
                      color={tokens.mutedForeground}
                    />
                  </Pressable>
                </View>
              ))}
              <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 96 }}>
                {!draft && !selectedSkill && !selectedMentions.length ? (
                  <Text
                    numberOfLines={1}
                    importantForAccessibility="no"
                    accessibilityElementsHidden
                    accessible={false}
                    pointerEvents="none"
                    style={{
                      position: "absolute",
                      top: 11,
                      start: 0,
                      end: 0,
                      fontSize: 17,
                      lineHeight: 22,
                      color: tokens.mutedForeground,
                    }}
                  >
                    {composerPrompt}
                  </Text>
                ) : null}
                <TextInput
                  value={draft}
                  onChangeText={updateDraft}
                  accessibilityLabel={composerPrompt}
                  onKeyPress={(event) => {
                    if (
                      event.nativeEvent.key === "Backspace" &&
                      draft.length === 0 &&
                      (selectedSkill !== null || selectedMentions.length > 0)
                    ) {
                      removeLastChip();
                    }
                  }}
                  keyboardAppearance={colorScheme}
                  multiline
                  textAlignVertical="top"
                  blurOnSubmit={false}
                  style={{
                    color: tokens.foreground,
                    fontSize: 17,
                    lineHeight: 22,
                    paddingTop: 11,
                    paddingBottom: 11,
                    maxHeight: 132,
                    writingDirection: "auto",
                  }}
                />
              </View>
            </View>
            {!canSend && botId && !onCall ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Call")}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                onPress={() => void startVoiceCall()}
                style={{ marginBottom: 8 }}
              >
                <GlassSurface
                  tint={tokens.primary}
                  style={composerPillStyle}
                  fallbackStyle={{ backgroundColor: tokens.primary }}
                >
                  <NativeSymbol
                    ios="waveform"
                    android="pulse-outline"
                    size={15}
                    color={tokens.primaryForeground}
                  />
                </GlassSurface>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Send")}
                disabled={sending || !canSend}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                onPress={() => void send()}
                style={{ marginBottom: 8, opacity: sending || !canSend ? 0.5 : 1 }}
              >
                <GlassSurface
                  tint={tokens.primary}
                  style={composerPillStyle}
                  fallbackStyle={{ backgroundColor: tokens.primary }}
                >
                  <NativeSymbol
                    ios="arrow.up"
                    android="arrow-up"
                    size={15}
                    color={tokens.primaryForeground}
                  />
                </GlassSurface>
              </Pressable>
            )}
          </GlassSurface>
          {working ? (
            <Pressable
              accessibilityLabel={t("Stop")}
              disabled={sending}
              onPress={() => void stop()}
              style={{ width: 44, height: 44, opacity: sending ? 0.5 : 1 }}
            >
              <GlassSurface
                shape="circle"
                style={styles.circleButton}
                fallbackStyle={{ borderColor: tokens.border, borderWidth: 1 }}
              >
                <NativeSymbol ios="stop.fill" android="stop" size={15} color={tokens.foreground} />
              </GlassSurface>
            </Pressable>
          ) : null}
        </View>
      </View>
      <Modal
        visible={botActionsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setBotActionsOpen(false)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            padding: 24,
            backgroundColor: tokens.overlay,
          }}
        >
          <Pressable
            accessibilityLabel={t("Cancel")}
            onPress={() => setBotActionsOpen(false)}
            style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
          />
          <View
            accessibilityViewIsModal
            style={{ backgroundColor: tokens.popover, borderRadius: 24, paddingVertical: 12 }}
          >
            {botActions.map((action) => (
              <Pressable
                key={action.text}
                accessibilityRole="button"
                onPress={() => {
                  setBotActionsOpen(false);
                  action.onPress();
                }}
                style={{ minHeight: 56, justifyContent: "center", paddingHorizontal: 24 }}
              >
                <Text
                  style={{
                    color: action.destructive ? tokens.destructive : tokens.popoverForeground,
                    fontSize: 16,
                  }}
                >
                  {action.text}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>
      <SelectTextSheet text={selectableText} onClose={() => setSelectableText(null)} />
      {markdownPreview && artifactTarget ? (
        <MarkdownArtifactPreview
          threadTarget={artifactTarget}
          target={markdownPreview}
          onClose={() => setMarkdownPreview(null)}
        />
      ) : null}
      {quoteTarget ? (
        <QuoteSheet
          message={quoteTarget}
          onCancel={() => setQuoteTarget(null)}
          onQuote={(excerpt) => {
            setReplyTarget(quoteTarget);
            setReplyQuote(excerpt);
            setQuoteTarget(null);
          }}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  const tokens = useMobileTokens();
  if (mention.kind === "routine") {
    return (
      <NativeSymbol ios="clock" android="time-outline" size={16} color={tokens.mutedForeground} />
    );
  }
  if (mention.kind === "connector") {
    return (
      <NativeSymbol
        ios="puzzlepiece.extension"
        android="extension-puzzle-outline"
        size={16}
        color={tokens.mutedForeground}
      />
    );
  }
  if (mention.kind === "group") {
    return (
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 9 }}>G</Text>
      </View>
    );
  }
  if (mention.kind === "everyone") {
    return (
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 9 }}>@</Text>
      </View>
    );
  }
  return (
    <View
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        backgroundColor: mention.color ?? tokens.mutedForeground,
      }}
    />
  );
}

function QuoteSheet({
  message,
  onCancel,
  onQuote,
}: {
  message: MobileMessage;
  onCancel: () => void;
  onQuote: (excerpt: string) => void;
}) {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const segments = useMemo(() => quotableMessageSegments(message.role, message.blocks), [message]);
  const [selection, setSelection] = useState<{
    segment: number;
    start: number;
    end: number;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const selectedText = selection === null ? undefined : segments[selection.segment];
  const start = selection ? Math.min(selection.start, selection.end) : 0;
  const end = selection ? Math.max(selection.start, selection.end) : 0;
  const excerpt =
    selectedText === undefined ? "" : truncateQuoteExcerpt(selectedText.slice(start, end).trim());

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <View
        accessibilityViewIsModal
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          // Page sheets clear the notch on iOS; Android modals are full-screen.
          paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
          paddingBottom: insets.bottom,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            paddingHorizontal: 20,
            paddingBottom: 12,
          }}
        >
          <NativeActionButton label={t("Cancel")} onPress={onCancel} prominence="plain" />
          <NativeActionButton
            disabled={!excerpt}
            fill={false}
            label={t("Quote")}
            onPress={() => onQuote(excerpt)}
            prominence={excerpt ? "primary" : "plain"}
          />
        </View>
        <ScrollView style={{ flex: 1, paddingHorizontal: 20 }}>
          {segments.map((text, index) => (
            <TextInput
              key={`${index}:${revision}`}
              multiline
              scrollEnabled={false}
              showSoftInputOnFocus={false}
              value={text}
              // Any edit (paste, hardware keyboard, dictation) remounts the
              // field with the source text — the excerpt slices the original,
              // so the displayed text must never diverge from it.
              onChangeText={() => setRevision((value) => value + 1)}
              style={{
                color: tokens.foreground,
                fontSize: 15.5,
                lineHeight: 23,
                padding: 0,
                marginTop: index === 0 ? 0 : 12,
                textAlignVertical: "top",
              }}
              onSelectionChange={(event) => {
                const range = event.nativeEvent.selection;
                // A collapsed caret (tap, focus change, the Quote press
                // itself) keeps the last real span armed.
                if (range.start === range.end) return;
                setSelection({ segment: index, ...range });
              }}
            />
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

function MentionChipIcon({ mention }: { mention: ComposerMention }) {
  const tokens = useMobileTokens();
  if (mention.kind === "routine") {
    return (
      <NativeSymbol ios="clock" android="time-outline" size={13} color={tokens.mutedForeground} />
    );
  }
  if (mention.kind === "connector") {
    return (
      <NativeSymbol
        ios="puzzlepiece.extension"
        android="extension-puzzle-outline"
        size={13}
        color={tokens.mutedForeground}
      />
    );
  }
  if (mention.kind === "group" || mention.kind === "everyone") {
    return (
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 9 }}>
          {mention.kind === "group" ? "G" : "@"}
        </Text>
      </View>
    );
  }
  return (
    <View
      style={{
        width: 14,
        height: 14,
        borderRadius: 4,
        backgroundColor: mention.color ?? tokens.mutedForeground,
      }}
    />
  );
}

function previewMessageText(message: MobileMessage): string {
  const text = message.blocks
    .flatMap((block) => {
      if (block.kind === "channel_message" && block.text) {
        return [
          `${messagingProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`,
        ];
      }
      if (block.kind === "text" && block.text) {
        // Bot text is Markdown; user text is already plain.
        return [message.role === "bot" ? plainTextFromMarkdown(block.text) : block.text];
      }
      return [];
    })
    .join(" ")
    .trim();
  if (text) return text;
  if (message.blocks.some((block) => block.kind === "image" || block.kind === "file")) {
    return t("Attachment");
  }
  return t("Message");
}

function memberName(
  members: MobileSnapshot["members"] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId || !members) return undefined;
  return members.find((member) => member.botId === botId)?.name;
}

/** Each bot keeps one identity color across web and mobile — same lookup as the avatar. */
function speakerColorFor(
  bots: MobileBot[],
  members: MobileSnapshot["members"] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId) return undefined;
  const raw =
    bots.find((bot) => bot.id === botId)?.color ??
    members?.find((member) => member.botId === botId)?.color;
  return resolvePersonaColorDef(botId, raw).light;
}

type MessageActionProps = Pick<
  TextProps,
  "onLongPress" | "accessibilityActions" | "onAccessibilityAction"
>;

const MessageBubble = memo(function MessageBubble({
  botId,
  botName,
  bots,
  groupId,
  message,
  members,
  replyPreview,
  canAnswer,
  onAnswer,
  onOpenBot,
  onOpenComputer,
  onChoiceDismissed,
  onPreviewMarkdown,
  onPreviewImage,
  actionProps,
}: {
  botId: string;
  botName?: string;
  bots: MobileBot[];
  groupId?: string;
  message: MobileMessage;
  members?: MobileSnapshot["members"];
  replyPreview?: MobileMessage;
  canAnswer: boolean;
  onAnswer: (message: MobileMessage, answer: string, username?: string) => Promise<void>;
  onOpenBot: (botId: string, name: string) => void;
  onOpenComputer: (botId: string, name: string) => void;
  onChoiceDismissed?: (question: string) => void;
  onPreviewMarkdown: (target: MarkdownArtifactPreviewTarget) => void;
  onPreviewImage: (target: ImageArtifactPreviewTarget) => void;
  actionProps: MessageActionProps;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const { t } = useI18n();
  const [peerExpanded, setPeerExpanded] = useState(false);
  const artifactTarget: MobileArtifactTarget = groupId ? { groupId } : { botId };
  const cardBotId = message.botId ?? botId;
  const computerBotId = message.botId ?? (groupId ? undefined : botId);
  const appConnectBlocks = message.blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "app_connect" }> =>
      block.kind === "app_connect",
  );
  const mcpApprovalBlocks = message.blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "mcp_approval" }> =>
      block.kind === "mcp_approval",
  );
  const ask = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "ask" }> =>
      block.kind === "ask" && !isApprovalAskBlock(block) && !block.actions?.length,
  );
  if (ask) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        <AskBlock
          ask={ask}
          actionProps={actionProps}
          canAnswer={canAnswer}
          onAnswer={(answer, username) => onAnswer(message, answer, username)}
        />
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
        {mcpApprovalBlocks.map((block) => (
          <McpApprovalCard
            key={block.serverId}
            botId={cardBotId}
            threadId={message.threadId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
      </View>
    );
  }
  const handoff = message.blocks.find((block) => block.kind === "handoff");
  if (handoff) {
    const from = memberName(members, handoff.fromBotId) ?? t("bot");
    const to = memberName(members, handoff.toBotId) ?? t("bot");
    return (
      <AgentEventLabel
        actionProps={actionProps}
        label={t("{from} messaged {to}", { from, to })}
        detail={handoff.text}
        expanded={peerExpanded}
        onToggle={() => setPeerExpanded((expanded) => !expanded)}
      />
    );
  }
  const peerMessage = message.blocks.find(
    (
      block,
    ): block is Extract<MessageBlock, { kind: "bot_message_sent" | "bot_message_received" }> =>
      block.kind === "bot_message_sent" || block.kind === "bot_message_received",
  );
  if (peerMessage) {
    const sent = peerMessage.kind === "bot_message_sent";
    const peer = sent ? peerMessage.toBotName : peerMessage.fromBotName;
    const peerBotId = sent ? peerMessage.toBotId : peerMessage.fromBotId;
    const label = sent
      ? t("Messaged {peer}", { peer: peer ?? t("Bot") })
      : t("Message from {peer}", { peer: peer ?? t("Bot") });
    const peerColor =
      bots.find((bot) => bot.id === peerBotId)?.color ??
      members?.find((member) => member.botId === peerBotId)?.color ??
      tokens.mutedForeground;
    // Compact receipt only: peer bodies stay out of the human thread.
    // Full view-only peer chat is web-first; mobile keeps the chip without expand.
    return (
      <Pressable
        {...actionProps}
        accessible
        accessibilityLabel={label}
        style={{
          width: "100%",
          paddingVertical: 4,
          alignItems: "center",
          justifyContent: "flex-start",
          flexDirection: "row",
          gap: 6,
        }}
      >
        <BotAvatar color={peerColor} identity={peerBotId} size={16} />
        <Text
          numberOfLines={1}
          style={{ color: tokens.mutedForeground, fontSize: 13.5, flexShrink: 1 }}
        >
          {label}
        </Text>
      </Pressable>
    );
  }
  const channelMessage = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "channel_message" }> =>
      block.kind === "channel_message",
  );
  if (channelMessage) {
    return (
      <Pressable
        {...actionProps}
        style={{ width: "100%", paddingVertical: 4, alignItems: "center" }}
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 13.5, textAlign: "center" }}>
          {messagingProviderLabel(channelMessage.provider, channelMessage.transport)} ·{" "}
          {channelMessage.fromLabel}: {channelMessage.text}
        </Text>
      </Pressable>
    );
  }
  const special = message.blocks.find(
    (block) =>
      block.kind === "subagent" || block.kind === "child_bot" || block.kind === "cloud_agent",
  );
  if (special?.kind === "subagent") {
    const running = special.status === "running";
    const failed = special.status === "failed";
    return (
      <Pressable
        {...actionProps}
        style={{
          width: "90%",
          borderRadius: 18,
          borderWidth: 1,
          borderColor: tokens.border,
          backgroundColor: tokens.card,
          paddingHorizontal: 16,
          paddingVertical: 14,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Text style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}>
            {special.name || t("subagent")}
          </Text>
          <Text
            style={{
              color: failed ? tokens.destructive : running ? tokens.warning : tokens.success,
              fontSize: 13,
            }}
          >
            {running
              ? t("Running")
              : special.status === "failed"
                ? t("Failed")
                : special.status === "completed"
                  ? t("Completed")
                  : special.status}
          </Text>
        </View>
        {special.task ? (
          <Text style={{ color: tokens.mutedForeground, marginTop: 8, fontSize: 13.5 }}>
            {special.task}
          </Text>
        ) : null}
        {special.result || special.progress ? (
          <View style={{ marginTop: 8 }}>
            <ChatMarkdown palette={tokens} colorScheme={colorScheme} streaming={running}>
              {special.result || special.progress || ""}
            </ChatMarkdown>
          </View>
        ) : null}
      </Pressable>
    );
  }
  if (special?.kind === "cloud_agent") {
    const title = special.title || t("Cloud agent");
    const statusLabel =
      special.status === "running"
        ? t("running")
        : special.status === "finished"
          ? t("finished")
          : special.status === "cancelled"
            ? t("cancelled")
            : t("failed");
    const running = special.status === "running";
    const failed = special.status === "failed" || special.status === "cancelled";
    const prHref = cloudAgentHttpsUrl(special.prUrl);
    const href = prHref ?? cloudAgentHttpsUrl(special.url);
    return (
      <Pressable
        onPress={() => {
          if (href) Linking.openURL(href).catch(() => undefined);
        }}
        testID="cloud-agent-card"
        accessibilityRole={href ? "link" : "text"}
        accessibilityLabel={`${title}: ${statusLabel}`}
        disabled={!href}
        style={{
          width: "90%",
          borderRadius: 18,
          borderWidth: 1,
          borderColor: tokens.border,
          backgroundColor: tokens.card,
          paddingHorizontal: 16,
          paddingVertical: 14,
        }}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          <Text style={{ color: tokens.cardForeground, fontSize: 15, fontWeight: "600" }}>
            {title}
          </Text>
          <Text
            style={{
              color: failed ? tokens.destructive : running ? tokens.warning : tokens.success,
              fontSize: 13,
            }}
          >
            {statusLabel}
          </Text>
        </View>
        {prHref ? (
          <Text style={{ color: tokens.mutedForeground, marginTop: 8, fontSize: 14.5 }}>
            {t("Pull request")}
          </Text>
        ) : special.branch ? (
          <Text style={{ color: tokens.mutedForeground, marginTop: 8, fontSize: 13.5 }}>
            {special.branch}
          </Text>
        ) : null}
      </Pressable>
    );
  }
  if (special?.kind === "child_bot") {
    const removed = special.status === "deleted" || special.status === "archived";
    return (
      <Pressable
        {...actionProps}
        onPress={
          removed ? undefined : () => onOpenBot(special.botId ?? "", special.name ?? t("Bot"))
        }
        style={{
          width: "90%",
          borderRadius: 18,
          borderWidth: 1,
          borderColor: tokens.border,
          backgroundColor: tokens.card,
          paddingHorizontal: 16,
          paddingVertical: 14,
          opacity: removed ? 0.6 : 1,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Text style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}>
            {special.name || t("Bot")}
          </Text>
          <Text style={{ color: removed ? tokens.destructive : tokens.success, fontSize: 13 }}>
            {special.status === "archived"
              ? t("archived")
              : special.status === "deleted"
                ? t("deleted")
                : t("bot")}
          </Text>
        </View>
        <Text
          style={{
            color: tokens.mutedForeground,
            marginTop: 8,
            fontSize: 14.5,
            lineHeight: 21,
          }}
        >
          {removed
            ? special.status === "archived"
              ? t("Archived. Chat, memory, and files kept.")
              : t("Removed with chat, computer, and memory.")
            : special.title || t("Opened its thread.")}
        </Text>
      </Pressable>
    );
  }
  const inlineCardCount = appConnectBlocks.length + mcpApprovalBlocks.length;
  if (inlineCardCount > 0 && inlineCardCount === message.blocks.length) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
        {mcpApprovalBlocks.map((block) => (
          <McpApprovalCard
            key={block.serverId}
            botId={cardBotId}
            threadId={message.threadId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
      </View>
    );
  }
  const askBlock = message.blocks.find(
    (block) => block.kind === "ask" && Boolean(block.actions?.length),
  );
  if (askBlock?.kind === "ask" && askBlock.actions?.length) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        <View
          style={{
            width: "90%",
            borderRadius: 18,
            borderWidth: 1,
            borderColor: tokens.border,
            backgroundColor: tokens.card,
            paddingHorizontal: 16,
            paddingVertical: 14,
          }}
        >
          {askBlock.text ? (
            <Text
              {...actionProps}
              style={{ color: tokens.foreground, fontSize: 15.5, lineHeight: 23 }}
            >
              {askBlock.text}
            </Text>
          ) : null}
          {askBlock.detail ? (
            <Text
              {...(askBlock.text ? {} : actionProps)}
              style={{
                color: tokens.mutedForeground,
                marginTop: askBlock.text ? 8 : 0,
                fontSize: 12.5,
                fontFamily: "Menlo",
                lineHeight: 20,
              }}
            >
              {askBlock.detail}
            </Text>
          ) : null}
          {askBlock.status === "answered" ? (
            <Text
              {...actionProps}
              style={{
                color: tokens.success,
                marginTop: 12,
                fontSize: 13.5,
                fontWeight: "600",
              }}
            >
              {formatApprovalAnswer(
                askBlock.answer,
                askBlock.actions,
                isApprovalAskBlock(askBlock),
              )}
            </Text>
          ) : canAnswer && onAnswer ? (
            <AskActions
              actions={askBlock.actions}
              accessibilityActions={actionProps.accessibilityActions}
              onAccessibilityAction={actionProps.onAccessibilityAction}
              onAnswer={(answer) => onAnswer(message, answer)}
            />
          ) : (
            <Text
              {...actionProps}
              style={{ color: tokens.mutedForeground, marginTop: 12, fontSize: 13.5 }}
            >
              {t("No longer active")}
            </Text>
          )}
        </View>
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
        {mcpApprovalBlocks.map((block) => (
          <McpApprovalCard
            key={block.serverId}
            botId={cardBotId}
            threadId={message.threadId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
      </View>
    );
  }
  const attachments = message.blocks.filter(
    (block) => block.kind === "image" || block.kind === "file",
  );
  const caption = message.blocks
    .flatMap((block) => {
      if (block.kind === "channel_message" && block.text) {
        return [
          `${messagingProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`,
        ];
      }
      return block.kind === "text" && block.text ? [block.text] : [];
    })
    .join("\n");
  if (attachments.length > 0) {
    const speaker =
      message.role === "bot" ? (memberName(members, message.botId) ?? botName) : undefined;
    const speakerColor =
      message.role === "bot" ? speakerColorFor(bots, members, message.botId) : undefined;
    return (
      <View
        style={{
          maxWidth: "100%",
          borderRadius: 20,
          borderWidth: 1,
          borderColor: tokens.border,
          backgroundColor: message.role === "user" ? tokens.secondary : tokens.muted,
          paddingHorizontal: 14,
          paddingVertical: 12,
          gap: 8,
        }}
      >
        {speaker ? (
          <Text
            style={{
              color: speakerColor ?? tokens.mutedForeground,
              fontSize: 12.5,
              fontWeight: "600",
            }}
          >
            {speaker}
          </Text>
        ) : null}
        {replyPreview || (message.replyToMessageId && message.replyQuote) ? (
          <Text
            style={{
              color: message.role === "user" ? tokens.secondaryForeground : tokens.mutedForeground,
              fontSize: 12.5,
            }}
            numberOfLines={2}
          >
            {message.replyQuote
              ? `“${message.replyQuote}”`
              : replyPreview
                ? previewMessageText(replyPreview)
                : ""}
          </Text>
        ) : null}
        {caption ? (
          <Text
            style={{
              color: message.role === "user" ? tokens.secondaryForeground : tokens.foreground,
              fontSize: 15,
            }}
          >
            {caption}
          </Text>
        ) : null}
        {attachments.map((attachment, index) =>
          attachment.kind === "image" ? (
            attachment.artifactId && isInlineImageMimeType(attachment.mimeType) ? (
              <InlineImageAttachment
                key={`${attachment.artifactId}-${index}`}
                threadTarget={artifactTarget}
                artifactId={attachment.artifactId}
                name={attachment.name ?? t("Image")}
                mimeType={attachment.mimeType ?? "image/png"}
                labelColor={
                  message.role === "user" ? tokens.secondaryForeground : tokens.foreground
                }
                pressableProps={actionProps}
                onOpen={() =>
                  onPreviewImage({
                    artifactId: attachment.artifactId!,
                    name: attachment.name ?? t("Image"),
                    mimeType: attachment.mimeType ?? "image/png",
                  })
                }
              />
            ) : (
              <Pressable
                {...actionProps}
                key={`${attachment.artifactId ?? attachment.name ?? "image"}-${index}`}
                onPress={() =>
                  attachment.artifactId
                    ? void openMobileArtifact(
                        artifactTarget,
                        attachment.artifactId,
                        attachment.name ?? t("Image"),
                        attachment.mimeType ?? "image/png",
                      ).catch((err) =>
                        Alert.alert(t("Could not open image"), errorText(err, t("Try again."))),
                      )
                    : undefined
                }
              >
                <Text
                  style={{
                    color: message.role === "user" ? tokens.secondaryForeground : tokens.foreground,
                    fontSize: 15,
                  }}
                >
                  🖼 {attachment.name ?? t("Image")}
                </Text>
              </Pressable>
            )
          ) : (
            <Pressable
              {...actionProps}
              key={`${attachment.artifactId ?? attachment.name ?? "file"}-${index}`}
              onPress={() =>
                attachment.artifactId
                  ? attachment.mimeType === "text/markdown"
                    ? onPreviewMarkdown({
                        artifactId: attachment.artifactId,
                        name: attachment.name ?? t("Markdown file"),
                        mimeType: attachment.mimeType,
                      })
                    : void openMobileArtifact(
                        artifactTarget,
                        attachment.artifactId,
                        attachment.name ?? t("File"),
                        attachment.mimeType ?? "text/plain",
                      ).catch((err) =>
                        Alert.alert(t("Could not open file"), errorText(err, t("Try again."))),
                      )
                  : undefined
              }
            >
              <Text
                style={{
                  color: message.role === "user" ? tokens.secondaryForeground : tokens.foreground,
                  fontSize: 15,
                }}
              >
                📎 {attachment.name ?? t("File")}
              </Text>
              {formatFileSize(attachment.size) ? (
                <Text
                  style={{
                    color: tokens.mutedForeground,
                    marginTop: 4,
                    fontSize: 13,
                  }}
                >
                  {formatFileSize(attachment.size)}
                </Text>
              ) : null}
            </Pressable>
          ),
        )}
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
        {mcpApprovalBlocks.map((block) => (
          <McpApprovalCard
            key={block.serverId}
            botId={cardBotId}
            threadId={message.threadId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
      </View>
    );
  }
  const segments = messagePresentationSegments(message.blocks);
  const speaker =
    message.role === "bot" ? (memberName(members, message.botId) ?? botName) : undefined;
  const speakerColor =
    message.role === "bot" ? speakerColorFor(bots, members, message.botId) : undefined;
  const firstContent = segments.findIndex((segment) => segment.kind === "content");
  const choiceBlocks = message.blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "choice" }> => block.kind === "choice",
  );
  const computerBlocks = message.blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "computer" }> => block.kind === "computer",
  );
  return (
    <View style={{ gap: 8, width: "100%" }}>
      {segments.map((segment, index) => (
        <MessageTextCard
          key={`${message.id}-content-${index}`}
          message={{ ...message, blocks: segment.blocks }}
          speaker={index === firstContent ? speaker : undefined}
          speakerColor={index === firstContent ? speakerColor : undefined}
          replyPreview={index === firstContent ? replyPreview : undefined}
          actionProps={actionProps}
        />
      ))}
      {choiceBlocks.map((block, index) => (
        <ChoiceCard
          key={`choice-${index}`}
          botId={cardBotId}
          block={block}
          onDismissed={onChoiceDismissed ? () => onChoiceDismissed(block.question) : undefined}
          accessibilityActions={actionProps.accessibilityActions}
          onAccessibilityAction={actionProps.onAccessibilityAction}
        />
      ))}
      {computerBlocks.map((block, index) => (
        <ComputerCard
          key={`computer-${index}`}
          block={block}
          onOpen={
            computerBotId ? () => onOpenComputer(computerBotId, speaker ?? t("Bot")) : undefined
          }
          accessibilityActions={actionProps.accessibilityActions}
          onAccessibilityAction={actionProps.onAccessibilityAction}
        />
      ))}
      {appConnectBlocks.map((block, index) => (
        <AppConnectCard
          key={`${block.provider}-${index}`}
          botId={cardBotId}
          block={block}
          accessibilityActions={actionProps.accessibilityActions}
          onAccessibilityAction={actionProps.onAccessibilityAction}
        />
      ))}
    </View>
  );
});

function MessageTextCard({
  message,
  speaker,
  speakerColor,
  replyPreview,
  actionProps,
}: {
  message: MobileMessage;
  speaker?: string;
  speakerColor?: string;
  replyPreview?: MobileMessage;
  actionProps: MessageActionProps;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const contentText = blockText(message);
  if (!contentText) return null;
  return (
    <Pressable
      {...actionProps}
      style={{
        flexShrink: 1,
        minWidth: 0,
        maxWidth: "100%",
        backgroundColor: message.role === "user" ? tokens.secondary : tokens.muted,
        padding: 12,
        borderRadius: 20,
      }}
    >
      {speaker ? (
        <Text
          style={{
            color: speakerColor ?? tokens.mutedForeground,
            fontSize: 12.5,
            fontWeight: "600",
            marginBottom: 4,
          }}
        >
          {speaker}
        </Text>
      ) : null}
      {replyPreview || (message.replyToMessageId && message.replyQuote) ? (
        <Text
          style={{
            color: message.role === "user" ? tokens.secondaryForeground : tokens.mutedForeground,
            fontSize: 12.5,
            marginBottom: 6,
          }}
          numberOfLines={2}
        >
          {message.replyQuote
            ? `“${message.replyQuote}”`
            : replyPreview
              ? previewMessageText(replyPreview)
              : ""}
        </Text>
      ) : null}
      {
        // User bubbles stay literal text on web and mobile. Only explicit URLs
        // and email addresses are links, so a sent address is tappable without
        // formatting bold or headings.
        message.role === "user" ? (
          <LinkifiedText color={tokens.secondaryForeground} linkColor={tokens.link}>
            {contentText}
          </LinkifiedText>
        ) : (
          <ChatMarkdown
            palette={tokens}
            colorScheme={colorScheme}
            streaming={message.id.startsWith("progress:")}
          >
            {contentText}
          </ChatMarkdown>
        )
      }
    </Pressable>
  );
}

function AgentEventLabel({
  label,
  detail,
  expanded,
  onToggle,
  actionProps,
}: {
  label: string;
  detail?: string;
  expanded: boolean;
  onToggle: () => void;
  actionProps: MessageActionProps;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const { t } = useI18n();
  return (
    <Pressable
      {...actionProps}
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={expanded ? t("Hide {label}", { label }) : t("Show {label}", { label })}
      style={{ width: "100%", paddingVertical: 4, alignItems: "center" }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <NativeSymbol
          ios="arrow.left.arrow.right"
          android="swap-horizontal"
          size={12}
          color={tokens.mutedForeground}
        />
        <Text style={{ color: tokens.mutedForeground, fontSize: 13.5, textAlign: "center" }}>
          {label}
        </Text>
      </View>
      {expanded && detail ? (
        <View
          style={{
            width: "100%",
            marginTop: 6,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: tokens.border,
            backgroundColor: tokens.card,
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
        >
          <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
            {detail}
          </ChatMarkdown>
        </View>
      ) : null}
    </Pressable>
  );
}

function AskBlock({
  ask,
  canAnswer,
  onAnswer,
  actionProps,
}: {
  ask: Extract<MobileMessage["blocks"][number], { kind: "ask" }>;
  canAnswer: boolean;
  onAnswer: (answer: string, username?: string) => Promise<void>;
  actionProps: MessageActionProps;
}) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const [answer, setAnswer] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const answered = ask.status === "answered";
  const secretInput = isSecretAskBlock(ask);
  const loginInput = secretInput && ask.credential?.auth.type === "login";
  const incomplete =
    (secretInput ? answer.length === 0 : !answer.trim()) || (loginInput && !username.trim());
  const secretLabel =
    loginInput || ask.purpose === "password"
      ? t("Password")
      : ask.purpose === "api_key"
        ? t("API key")
        : t("Code");
  const submitLabel = secretInput ? t("Save") : t("Send answer");

  async function submit() {
    if (submitting) return;
    if (incomplete) return;
    const submitValue = secretInput ? answer : answer.trim();
    const submitUsername = loginInput ? username.trim() : undefined;
    setSubmitting(true);
    setError(null);
    if (secretInput) setAnswer("");
    try {
      await onAnswer(submitValue, submitUsername);
    } catch (cause) {
      setError(
        secretInput ? t("Could not send answer") : errorText(cause, t("Could not send answer")),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View
      style={{
        width: "90%",
        borderRadius: 18,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.card,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 10,
      }}
    >
      <Text
        {...actionProps}
        style={{ color: tokens.foreground, fontSize: 15.5, fontWeight: "600" }}
      >
        {ask.text}
      </Text>
      {secretInput && ask.credential ? (
        <Text style={{ color: tokens.mutedForeground, fontSize: 13.5 }}>
          {ask.credential.origin}
        </Text>
      ) : null}
      {ask.detail && !secretInput ? (
        <Text style={{ color: tokens.mutedForeground, fontSize: 13.5 }}>{ask.detail}</Text>
      ) : null}
      {answered ? (
        <Text style={{ color: tokens.success, fontSize: 14 }}>
          {secretInput ? t("Saved") : t("Answered: {answer}", { answer: ask.answer ?? t("Done") })}
        </Text>
      ) : canAnswer ? (
        <>
          {loginInput ? (
            <TextInput
              accessibilityLabel={t("Username")}
              value={username}
              onChangeText={setUsername}
              placeholder={t("Username")}
              placeholderTextColor={tokens.mutedForeground}
              autoComplete="off"
              autoCorrect={false}
              autoCapitalize="none"
              editable={!submitting}
              style={[
                askInputStyles.field,
                { borderColor: tokens.border, color: tokens.foreground },
              ]}
            />
          ) : null}
          <TextInput
            accessibilityLabel={secretInput ? secretLabel : t("Answer")}
            value={answer}
            onChangeText={setAnswer}
            placeholder={secretInput ? secretLabel : t("Type your answer")}
            placeholderTextColor={tokens.mutedForeground}
            secureTextEntry={secretInput}
            autoComplete="off"
            autoCorrect={secretInput ? false : undefined}
            autoCapitalize={secretInput ? "none" : "sentences"}
            editable={!submitting}
            onSubmitEditing={() => void submit()}
            style={[askInputStyles.field, { borderColor: tokens.border, color: tokens.foreground }]}
          />
          <NativeActionButton
            label={submitLabel}
            disabled={incomplete}
            busy={submitting}
            fill={false}
            onPress={() => void submit()}
            style={{ alignSelf: "flex-end" }}
          />
        </>
      ) : (
        <Text style={{ color: tokens.mutedForeground, fontSize: 13.5 }}>
          {t("Waiting for this bot’s response.")}
        </Text>
      )}
      {error ? <Text style={{ color: tokens.destructive, fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}

const askInputStyles = StyleSheet.create({
  field: {
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
});
