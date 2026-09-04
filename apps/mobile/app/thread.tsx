import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type {
  AgentSkillCatalogEntry,
  Connection,
  ConnectionCatalogItem,
  MessageBlock,
  Routine,
} from "@rakazo/contracts";
import { canReactToThreadMessage } from "@rakazo/contracts";
import {
  abortableDelay,
  attachmentsForThread,
  buildComposerMentionOptions,
  type ComposerMention,
  isApprovalAskBlock,
  isRunTerminalEvent,
  isSecretAskBlock,
  latestAnswerableAskMessageId,
  mentionChipKey,
  resolveComposerSendPlan,
  SLASH_ACTIONS,
  type SlashActionId,
  selectedAskActionLabel,
  serializeComposerPrompt,
  truncateSlashDescription,
  userVisibleMessages,
} from "@rakazo/core";
import { Link, useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppConnectCard } from "../components/AppConnectCard";
import { AskActions } from "../components/AskActions";
import { BotAvatar } from "../components/bot-avatar";
import {
  MarkdownArtifactPreview,
  type MarkdownArtifactPreviewTarget,
} from "../components/markdown-artifact-preview";
import { NativeSymbol } from "../components/native-symbol";
import {
  applyMobileThreadEvent,
  blockText,
  currentApiBase,
  loadSessionToken,
  type MobileBot,
  type MobileGroup,
  type MobileMessage,
  type MobileMessagePage,
  type MobileSnapshot,
  mergeMobileSnapshot,
  messagingProviderLabel,
  prependMobileMessagePage,
  rpc,
  selectedSpaceId,
  selectSpace,
  shouldApplyMobileThreadRefresh,
  subscribeThread,
} from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { type MobileArtifactTarget, openMobileArtifact } from "../lib/artifact-open";
import { confirmDeleteBot } from "../lib/bot-lifecycle";
import { cancelFocusPrompt, focusPromptThreadActive } from "../lib/focus-prompt";
import { t, useI18n } from "../lib/i18n";
import { saveLastBotId } from "../lib/last-bot";
import {
  dismissThreadNotifications,
  resumeLiveNotifications,
  setOpenNotificationThread,
} from "../lib/live-notifications";
import {
  hasVisibleMessagePresentation,
  isCenteredAgentEvent,
  messagePresentationSegments,
} from "../lib/message-presentation";
import { native, useResolvedAppearance } from "../lib/native";
import {
  type PickedAttachment,
  pickDocuments,
  pickFromLibrary,
  takePhoto,
} from "../lib/pick-attachments";
import { threadRefreshDelayMs } from "../lib/refresh";
import {
  type ThreadScrollAction,
  ThreadScrollBehavior,
  type ThreadScrollState,
} from "../lib/thread-scroll";
import { speakText } from "../lib/voice";

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

type NotificationRouteState = "loading" | "ready" | "failed";

export default function ThreadRoute() {
  useResolvedAppearance();
  const { t } = useI18n();
  const router = useRouter();
  const { spaceId } = useLocalSearchParams<{ spaceId?: string | string[] }>();
  const requestedSpaceId = typeof spaceId === "string" && spaceId ? spaceId : null;
  const invalidSpaceId = spaceId !== undefined && requestedSpaceId === null;
  const routeMatchesSelectedSpace =
    requestedSpaceId === null || selectedSpaceId() === requestedSpaceId;
  const [routeState, setRouteState] = useState<NotificationRouteState>(() => {
    if (invalidSpaceId) return "failed";
    return routeMatchesSelectedSpace ? "ready" : "loading";
  });

  useEffect(() => {
    let cancelled = false;
    if (invalidSpaceId) {
      setRouteState("failed");
      return () => {
        cancelled = true;
      };
    }
    if (!requestedSpaceId || selectedSpaceId() === requestedSpaceId) {
      setRouteState("ready");
      return () => {
        cancelled = true;
      };
    }
    setRouteState("loading");
    void selectSpace(requestedSpaceId).then((selected) => {
      if (!cancelled) setRouteState(selected ? "ready" : "failed");
    });
    return () => {
      cancelled = true;
    };
  }, [invalidSpaceId, requestedSpaceId]);

  if (routeState === "ready" && !invalidSpaceId && routeMatchesSelectedSpace) return <Thread />;
  return (
    <View
      style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#000" }}
    >
      {routeState === "loading" ? (
        <ActivityIndicator color="#ECECEE" />
      ) : (
        <Pressable accessibilityRole="button" onPress={() => router.replace("/")}>
          <Text style={{ color: "#ECECEE", fontSize: 16 }}>{t("Return to inbox")}</Text>
        </Pressable>
      )}
    </View>
  );
}

function Thread() {
  const { t } = useI18n();
  const navigation = useNavigation();
  const router = useRouter();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const { botId, groupId, name, messageId } = useLocalSearchParams<{
    botId?: string;
    groupId?: string;
    name?: string;
    messageId?: string;
  }>();
  const inGroup = Boolean(groupId);
  const scroll = useRef<FlatList<MobileMessage>>(null);
  const pinnedScroll = useRef<ScrollView>(null);
  const scrollBehavior = useRef(new ThreadScrollBehavior());
  const userDragging = useRef(false);
  const loadingOlderContent = useRef(false);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const jumpGeneration = useRef(0);
  const pinnedAroundRef = useRef<{
    botId?: string;
    groupId?: string;
    messageId: string;
    threadId: string;
    messages: readonly MobileMessage[];
    olderCursor: number | null;
  } | null>(null);
  const jumpScrollTarget = useRef<string | null>(null);
  const activeBotId = useRef(botId);
  activeBotId.current = botId;
  const activeGroupId = useRef(groupId);
  activeGroupId.current = groupId;
  const readVisibleTarget = useRef<string | null>(null);
  const threadKey = groupId ?? botId;
  const [threadScrollState, setThreadScrollState] = useState<ThreadScrollState>(() =>
    scrollBehavior.current.state(),
  );
  useLayoutEffect(() => {
    scrollBehavior.current.openThread(threadKey ?? "");
    expandedHistoryThread.current = null;
    pinnedAroundRef.current = null;
    jumpScrollTarget.current = null;
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
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownArtifactPreviewTarget | null>(
    null,
  );
  const visibleMessages = useMemo(
    () =>
      userVisibleMessages(snap?.messages ?? [], { includePeerReceipts: true }).filter((message) =>
        hasVisibleMessagePresentation(message.blocks),
      ),
    [snap?.messages],
  );
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
  const notificationThreadId = snap?.threadId ?? currentBot?.threadId;
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

  useEffect(() => {
    void rpc<AgentSkillCatalogEntry[]>("agentSkills/list")
      .then(setAgentSkills)
      .catch(() => setAgentSkills([]));
  }, []);

  useEffect(() => {
    setThreadScrollState(scrollBehavior.current.state());
  }, [threadKey]);

  useEffect(() => {
    void rpc<MobileBot[]>("bots/list")
      .then(setMentionBots)
      .catch(() => setMentionBots([]));
    void rpc<MobileGroup[]>("groups/list")
      .then(setMentionGroups)
      .catch(() => setMentionGroups([]));
  }, []);

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
      title: name || t("Thread"),
      headerTitle: () => (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            maxWidth: 220,
          }}
        >
          {!inGroup && currentBot ? (
            <BotAvatar
              color={currentBot.color}
              identity={currentBot.id}
              size={34}
              status={currentBotStatus}
              muted={!currentBot.notifyOnFinish}
            />
          ) : null}
          <Text numberOfLines={1} style={{ color: "#ECECEE", fontSize: 18, fontWeight: "600" }}>
            {name || t("Thread")}
          </Text>
        </View>
      ),
      headerRight: () =>
        inGroup ? (
          <Pressable
            accessibilityLabel={t("Group settings")}
            hitSlop={8}
            onPress={() =>
              router.push({
                pathname: "/group-settings",
                params: { groupId: groupId ?? "" },
              })
            }
          >
            <NativeSymbol ios="gearshape" android="settings-outline" size={21} color="#ECECEE" />
          </Pressable>
        ) : (
          <Pressable accessibilityLabel={t("Bot actions")} hitSlop={8} onPress={showBotActions}>
            <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={21} color="#ECECEE" />
          </Pressable>
        ),
    });
  }, [botId, currentBot, currentBotStatus, groupId, inGroup, name, navigation, router, t]);

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
        setSnap((current) =>
          current ? { ...current, messages: [], olderCursor: null, run: null } : current,
        );
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t("Could not clear conversation")),
      );
  }

  function showBotActions() {
    if (!botId) return;
    const bot = { id: botId, name: name || t("Bot") };
    Alert.alert(bot.name, t("Archive keeps everything and can be undone. Delete is permanent."), [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Clear conversation"),
        style: "destructive",
        onPress: () => {
          Alert.alert(
            t("Clear conversation?"),
            t(
              "This removes every message and stops current work. The bot, computer, memory, and routines are kept.",
            ),
            [
              { text: t("Cancel"), style: "cancel" },
              {
                text: t("Clear"),
                style: "destructive",
                onPress: clearConversation,
              },
            ],
          );
        },
      },
      {
        text: t("Archive"),
        onPress: () =>
          void rpc("bots/archive", { botId })
            .then(leaveBot)
            .catch((error) =>
              Alert.alert(
                t("Could not archive bot"),
                error instanceof Error ? error.message : t("Try again."),
              ),
            ),
      },
      {
        text: t("Delete…"),
        style: "destructive",
        onPress: () => confirmDeleteBot(bot, leaveBot),
      },
    ]);
  }

  async function refresh() {
    if (!botId && !groupId) return;
    const targetBotId = botId;
    const targetGroupId = groupId;
    const epoch = historyEpoch.current;
    const next = await rpc<MobileSnapshot>(
      "threads/get",
      targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! },
    );
    if (
      !shouldApplyMobileThreadRefresh({
        requestEpoch: epoch,
        currentEpoch: historyEpoch.current,
        targetBotId,
        targetGroupId,
        activeBotId: activeBotId.current,
        activeGroupId: activeGroupId.current,
      })
    )
      return next;
    setSnap((prev) =>
      mergeMobileSnapshot(prev, next, expandedHistoryThread.current === next.threadId),
    );
    return next;
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
    expandedHistoryThread.current = targetInPage ? page.threadId : null;
    pinnedAroundRef.current = targetInPage
      ? {
          ...threadTarget,
          messageId: target.messageId,
          threadId: page.threadId,
          messages: [...page.messages],
          olderCursor: page.olderCursor,
        }
      : null;
    jumpScrollTarget.current = targetInPage ? target.messageId : null;
    setSnap({
      ...snap,
      messages: targetInPage ? [...page.messages] : snap.messages,
      olderCursor: targetInPage ? page.olderCursor : snap.olderCursor,
    });
  }

  async function loadOlderMessages() {
    if ((!botId && !groupId) || snap?.olderCursor == null || loadingOlder) return;
    loadingOlderContent.current = true;
    setLoadingOlder(true);
    const epoch = historyEpoch.current;
    try {
      const page = await rpc<MobileMessagePage>("threads/messages", {
        ...(groupId ? { groupId } : { botId: botId! }),
        before: snap.olderCursor,
        includePeerReceipts: true,
      });
      if (epoch !== historyEpoch.current) {
        loadingOlderContent.current = false;
        return;
      }
      expandedHistoryThread.current = page.threadId;
      setSnap((prev) => prependMobileMessagePage(prev, page));
    } catch (err) {
      loadingOlderContent.current = false;
      setError(err instanceof Error ? err.message : t("Could not load earlier messages"));
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
      markReadIfVisible();
      return () => {
        void setOpenNotificationThread(null).catch(() => undefined);
      };
    }, [botId, markReadIfVisible, notificationThreadId]),
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
    }
    expandedHistoryThread.current = null;
    historyEpoch.current += 1;
    const abort = new AbortController();
    void (async () => {
      // Pending search jumps load the around-page separately; avoid replacing it with latest.
      const next = messageId
        ? await rpc<MobileSnapshot>("threads/get", groupId ? { groupId } : { botId: botId! }).catch(
            (err: Error) => {
              setError(err.message);
              return null;
            },
          )
        : await refresh().catch((err: Error) => {
            setError(err.message);
            return null;
          });
      if (abort.signal.aborted) return;
      let cursor = next?.cursor ?? -1;
      let retryMs = 250;
      while (!abort.signal.aborted) {
        try {
          await subscribeThread(
            groupId ? { groupId } : { botId: botId! },
            cursor,
            (event) => {
              cursor = Math.max(cursor, event.seq ?? -1);
              retryMs = 250;
              if (
                event.type === "thread.progress" ||
                event.type === "agent.tool.called" ||
                event.type === "thread.message.created" ||
                event.type === "thread.message.updated" ||
                event.type === "thread.message.reaction" ||
                event.type === "thread.subagent" ||
                event.type === "thread.cleared" ||
                event.type === "run.waiting_input" ||
                isRunTerminalEvent(event)
              ) {
                if (event.type === "thread.cleared") {
                  expandedHistoryThread.current = null;
                  pinnedAroundRef.current = null;
                  historyEpoch.current += 1;
                }
                setSnap((prev) => applyMobileThreadEvent(prev, event));
              }
              if (event.type === "thread.message.created" && event.payload?.role === "bot") {
                readVisibleTarget.current = null;
                markReadIfVisible();
              }
              if (isRunTerminalEvent(event)) {
                if (!jumpScrollTarget.current && !expandedHistoryThread.current) {
                  void refresh().catch(() => undefined);
                }
              }
            },
            abort.signal,
          );
        } catch {
          // A full refresh reconciles visible state; the event cursor still resumes without gaps.
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
  }, [botId, groupId, markReadIfVisible]);

  useEffect(() => {
    if (!botId && !groupId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
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
        timer = setTimeout(() => void tick(), threadRefreshDelayMs(snap?.run?.status));
      }
    };
    timer = setTimeout(() => void tick(), threadRefreshDelayMs(snap?.run?.status));
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [botId, groupId, navigation, snap?.run?.status]);

  useEffect(() => {
    if ((!botId && !groupId) || !messageId) return;
    void applyMessageJump(groupId ? { groupId, messageId } : { botId: botId!, messageId }).catch(
      (err) => {
        setError(err instanceof Error ? err.message : t("Could not open message"));
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
            }
          : {
              botId: botTarget!,
              clientNonce,
              text: trimmed || undefined,
              mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
              artifactIds: artifactIds.length ? artifactIds : undefined,
              replyToMessageId: replyTarget?.id,
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
        await refresh();
      }
    } catch (err) {
      if (reroutedToGroup && groupTarget) {
        setError(err instanceof Error ? err.message : t("Failed to send message"));
      } else if (isCurrentTarget(botTarget, groupTarget)) {
        setError(err instanceof Error ? err.message : t("Failed to send message"));
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
        setError(err instanceof Error ? err.message : t("Failed to stop work"));
      }
      setSending(false);
      return;
    }
    try {
      await refresh();
    } catch (err) {
      if (isCurrentTarget(targetBotId, targetGroupId)) {
        const detail = err instanceof Error ? err.message : t("Failed to refresh");
        setError(t("Work stopped, but the thread could not refresh: {detail}", { detail }));
      }
    } finally {
      setSending(false);
    }
  }

  const answerMessage = useCallback(
    async (message: MobileMessage, answer: string) => {
      const targetBotId = botId;
      const targetGroupId = groupId;
      if ((!targetBotId && !targetGroupId) || !message.runId) return;
      await rpc("threads/answer", {
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        runId: message.runId,
        messageId: message.id,
        answer,
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

  const speak = useCallback(
    (message: MobileMessage) =>
      void speakMessage(message.botId ?? botId ?? snap?.members?.[0]?.botId ?? "", message).catch(
        (err) =>
          Alert.alert(t("Could not speak"), err instanceof Error ? err.message : t("Try again.")),
      ),
    [botId, snap?.members],
  );

  function showAttachMenu() {
    Alert.alert(t("Attach"), undefined, [
      {
        text: t("Photo library"),
        onPress: () => void addAttachments(pickFromLibrary),
      },
      { text: t("Camera"), onPress: () => void addAttachments(takePhoto) },
      { text: t("File"), onPress: () => void addAttachments(pickDocuments) },
      { text: t("Cancel"), style: "cancel" },
    ]);
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
  const liveMessages = useMemo(() => [...visibleMessages].reverse(), [visibleMessages]);
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

  function performScroll(action: ThreadScrollAction) {
    if (!action || showPinnedPage) return;
    scroll.current?.scrollToOffset({
      offset: 0,
      animated: action === "smooth" && !reducedMotion,
    });
  }

  function updateUserScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    // Inverted FlatList: contentOffset.y is distance from the latest messages.
    setThreadScrollState(
      scrollBehavior.current.onUserScroll(Math.max(0, event.nativeEvent.contentOffset.y)),
    );
  }

  async function reactToMessage(message: MobileMessage) {
    const targetBotId = botId;
    const targetGroupId = groupId;
    if (!targetBotId && !targetGroupId) return;
    try {
      await rpc("threads/react", {
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        messageId: message.id,
        thumbsUp: !message.thumbsUp,
      });
    } catch (err) {
      if (!isCurrentTarget(targetBotId, targetGroupId)) return;
      setError(err instanceof Error ? err.message : t("Could not update reaction"));
    }
  }

  function renderMessageRow(message: MobileMessage, options?: { enableJump?: boolean }) {
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
                if (jumpScrollTarget.current !== message.id) return;
                const y = Math.max(0, event.nativeEvent.layout.y - 24);
                requestAnimationFrame(() => {
                  if (jumpScrollTarget.current !== message.id) return;
                  pinnedScroll.current?.scrollTo({ y, animated: true });
                  jumpScrollTarget.current = null;
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
              color={activityBot?.color ?? "#85858A"}
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
          <View
            style={{
              alignSelf: message.role === "user" ? "flex-end" : "flex-start",
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              marginBottom: 4,
            }}
          >
            <Pressable accessibilityLabel={t("Reply")} onPress={() => setReplyTarget(message)}>
              <Text style={{ color: "#6C6C70", fontSize: 12 }}>{t("Reply")}</Text>
            </Pressable>
            {canReactToThreadMessage(message) ? (
              <Pressable
                accessibilityLabel={message.thumbsUp ? t("Remove thumbs-up") : t("Add thumbs-up")}
                accessibilityState={{ selected: Boolean(message.thumbsUp) }}
                onPress={() => void reactToMessage(message)}
              >
                <Text style={{ color: message.thumbsUp ? "#E9C46A" : "#6C6C70", fontSize: 13 }}>
                  👍
                </Text>
              </Pressable>
            ) : null}
          </View>
          <MessageBubble
            botId={botId ?? snap?.members?.[0]?.botId ?? ""}
            groupId={groupId}
            message={message}
            botName={name}
            bots={mentionBots}
            members={snap?.members}
            replyPreview={
              message.replyToMessageId ? messagesById.get(message.replyToMessageId) : undefined
            }
            canAnswer={message.id === answerableAskMessageId}
            onAnswer={answerMessage}
            onOpenBot={openBot}
            onPreviewMarkdown={setMarkdownPreview}
            onSpeak={message.role === "bot" ? speak : undefined}
          />
        </View>
      </View>
    );
  }

  const workingFooter =
    !inGroup && currentBot && isWorkingStatus(currentBotStatus) && !hasLiveProgress ? (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
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
        <Text style={{ color: "#85858A", fontSize: 13.5 }}>
          {t("{name} is working", { name: currentBot.name })}
        </Text>
      </View>
    ) : inGroup && workingGroupBots.length > 0 ? (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
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
        <Text style={{ color: "#85858A", fontSize: 13.5, flexShrink: 1 }}>
          {workingGroupBots.length === 1
            ? t("{name} is working", { name: workingGroupBots[0]?.name ?? t("Agent") })
            : t("{count} agents working", { count: workingGroupBots.length })}
        </Text>
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
        <Text style={{ color: "#85858A", fontSize: 13 }}>
          {loadingOlder ? t("Loading…") : t("Load earlier messages")}
        </Text>
      </Pressable>
    ) : null;

  return (
    <KeyboardAvoidingView
      behavior="height"
      keyboardVerticalOffset={headerHeight}
      style={{ flex: 1, backgroundColor: "#000", paddingHorizontal: 20 }}
    >
      {error ? <Text style={{ color: "#8E8E93", marginTop: 12 }}>{error}</Text> : null}
      {runError ? <Text style={{ color: "#EF4444", marginTop: 12 }}>{runError}</Text> : null}
      <View style={{ flex: 1, position: "relative" }}>
        {showPinnedPage ? (
          <ScrollView
            key={jumpScrollTarget.current ?? pinnedTarget?.messageId ?? threadKey}
            ref={pinnedScroll}
            style={{ flex: 1, marginTop: 8 }}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          >
            {loadEarlierControl}
            {visibleMessages.map((message) => renderMessageRow(message, { enableJump: true }))}
            {workingFooter}
          </ScrollView>
        ) : (
          <FlatList
            key={threadKey}
            ref={scroll}
            data={liveMessages}
            inverted
            keyExtractor={(message) => message.id}
            extraData={answerableAskMessageId}
            style={{ flex: 1, marginTop: 8 }}
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
            renderItem={({ item }) => renderMessageRow(item)}
          />
        )}
        {!showPinnedPage && threadScrollState.detached ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              threadScrollState.unread ? t("Jump to latest, new messages") : t("Jump to latest")
            }
            onPress={() => {
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
              borderRadius: 21,
              borderWidth: 1,
              borderColor: native.fillPressed,
              backgroundColor: native.fill,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <NativeSymbol
              ios="arrow.down"
              android="arrow-down"
              size={18}
              color={mobileTokens().foreground}
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
                  backgroundColor: "#4C8DFF",
                }}
              />
            ) : null}
          </Pressable>
        ) : null}
      </View>
      <View style={{ paddingBottom: Math.max(insets.bottom + 12, 24) }}>
        {replyTarget ? (
          <View
            style={{
              marginTop: 12,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: "#26262A",
              backgroundColor: "#17171A",
              paddingHorizontal: 12,
              paddingVertical: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: "#85858A", fontSize: 12 }}>{t("Replying to")}</Text>
              <Text style={{ color: "#C9C9CE", fontSize: 13 }} numberOfLines={1}>
                {previewMessageText(replyTarget)}
              </Text>
            </View>
            <Pressable accessibilityLabel={t("Cancel reply")} onPress={() => setReplyTarget(null)}>
              <Text style={{ color: "#85858A" }}>✕</Text>
            </Pressable>
          </View>
        ) : null}
        {attachmentNotice ? (
          <Text style={{ color: "#D6CFA0", marginTop: 12, fontSize: 13 }}>{attachmentNotice}</Text>
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
                  borderColor: "#26262A",
                  backgroundColor: "#17171A",
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
                  <Text style={{ color: "#C9C9CE" }}>📎</Text>
                )}
                <Text style={{ color: "#C9C9CE", maxWidth: 140 }} numberOfLines={1}>
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
                  <NativeSymbol ios="xmark" android="close" size={14} color="#85858A" />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        {mentionOptions.length ? (
          <View
            testID="mention-picker"
            style={{
              marginTop: 12,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: "#26262A",
              backgroundColor: "#17171A",
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
                  <Text style={{ color: "#ECECEE", fontSize: 14 }}>@{mention.name}</Text>
                  {mention.subtitle ? (
                    <Text
                      numberOfLines={1}
                      style={{
                        color: "#85858A",
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
          </View>
        ) : null}
        {slashSkillOptions.length || slashActionOptions.length ? (
          <View
            testID="slash-picker"
            style={{
              marginTop: 12,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: "#26262A",
              backgroundColor: "#17171A",
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
                <NativeSymbol ios="cube" android="cube-outline" size={16} color="#9A9AA0" />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: "#ECECEE", fontSize: 14 }}>{skill.name}</Text>
                  <Text
                    numberOfLines={1}
                    style={{ color: "#85858A", fontSize: 12.5, marginTop: 2 }}
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
                  color="#9A9AA0"
                />
                <Text style={{ color: "#ECECEE", fontSize: 14 }}>{t(action.label)}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View
          style={{
            flexDirection: "row",
            gap: 8,
            marginTop: 16,
            alignItems: "flex-end",
          }}
        >
          <Pressable
            accessibilityLabel={t("Attach file")}
            onPress={showAttachMenu}
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              borderWidth: 1,
              borderColor: "#26262A",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <NativeSymbol ios="plus" android="add" size={18} color="#9A9AA0" />
          </Pressable>
          <View
            style={{
              flex: 1,
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 6,
              backgroundColor: "#131315",
              borderRadius: 20,
              paddingHorizontal: 10,
              paddingVertical: 8,
              minHeight: 44,
            }}
          >
            {selectedSkill ? (
              <View
                testID="skill-chip"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  backgroundColor: "#1C1C1F",
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  maxWidth: "100%",
                }}
              >
                <NativeSymbol ios="cube" android="cube-outline" size={13} color="#B0B0B6" />
                <Text numberOfLines={1} style={{ color: "#ECECEE", fontSize: 13, flexShrink: 1 }}>
                  {selectedSkill.name}
                </Text>
                <Pressable
                  accessibilityLabel={t("Remove skill {name}", { name: selectedSkill.name })}
                  hitSlop={8}
                  onPress={() => setSelectedSkill(null)}
                >
                  <NativeSymbol ios="xmark" android="close" size={12} color="#85858A" />
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
                  backgroundColor: "#1C1C1F",
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  maxWidth: "100%",
                }}
              >
                <MentionChipIcon mention={mention} />
                <Text numberOfLines={1} style={{ color: "#ECECEE", fontSize: 13, flexShrink: 1 }}>
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
                  <NativeSymbol ios="xmark" android="close" size={12} color="#85858A" />
                </Pressable>
              </View>
            ))}
            <TextInput
              value={draft}
              onChangeText={updateDraft}
              accessibilityLabel={name ? t("Message {name}", { name }) : t("Message")}
              onKeyPress={(event) => {
                if (
                  event.nativeEvent.key === "Backspace" &&
                  draft.length === 0 &&
                  (selectedSkill !== null || selectedMentions.length > 0)
                ) {
                  removeLastChip();
                }
              }}
              placeholder={
                selectedSkill || selectedMentions.length
                  ? undefined
                  : name
                    ? t("Message {name}", { name })
                    : t("Message…")
              }
              placeholderTextColor="#6C6C70"
              keyboardAppearance="dark"
              multiline
              textAlignVertical="center"
              blurOnSubmit={false}
              style={{
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 96,
                color: "#ECECEE",
                paddingVertical: 2,
                maxHeight: 100,
                writingDirection: "auto",
              }}
            />
          </View>
          <Pressable
            accessibilityLabel={t("Send")}
            disabled={sending || !canSend}
            onPress={() => void send()}
            style={{
              backgroundColor: "#F1F1EF",
              borderRadius: 22,
              width: 44,
              height: 44,
              alignItems: "center",
              justifyContent: "center",
              opacity: sending || !canSend ? 0.5 : 1,
            }}
          >
            <NativeSymbol ios="arrow.up" android="arrow-up" size={18} color="#17171A" />
          </Pressable>
          {working ? (
            <Pressable
              accessibilityLabel={t("Stop")}
              disabled={sending}
              onPress={() => void stop()}
              style={{
                borderColor: "#34343A",
                borderWidth: 1,
                borderRadius: 22,
                width: 44,
                height: 44,
                alignItems: "center",
                justifyContent: "center",
                opacity: sending ? 0.5 : 1,
              }}
            >
              <NativeSymbol ios="stop.fill" android="stop" size={15} color="#C9C9CE" />
            </Pressable>
          ) : null}
        </View>
        {!inGroup ? (
          <Link
            href={{
              pathname: "/computer",
              params: { botId: botId ?? "", name: name ?? t("Bot") },
            }}
            asChild
          >
            <Pressable style={{ marginTop: 16 }}>
              <Text style={{ color: "#C9C9CE" }}>{t("Open computer →")}</Text>
            </Pressable>
          </Link>
        ) : null}
      </View>
      {markdownPreview && artifactTarget ? (
        <MarkdownArtifactPreview
          threadTarget={artifactTarget}
          target={markdownPreview}
          onClose={() => setMarkdownPreview(null)}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <NativeSymbol ios="clock" android="time-outline" size={16} color="#9A9AA0" />;
  }
  if (mention.kind === "connector") {
    return (
      <NativeSymbol
        ios="puzzlepiece.extension"
        android="extension-puzzle-outline"
        size={16}
        color="#9A9AA0"
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
          backgroundColor: "#2A2A2E",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: "#C9C9CE", fontSize: 9 }}>G</Text>
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
          backgroundColor: "#2A2A2E",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: "#C9C9CE", fontSize: 9 }}>@</Text>
      </View>
    );
  }
  return (
    <View
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        backgroundColor: mention.color ?? "#85858A",
      }}
    />
  );
}

function MentionChipIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <NativeSymbol ios="clock" android="time-outline" size={13} color="#B0B0B6" />;
  }
  if (mention.kind === "connector") {
    return (
      <NativeSymbol
        ios="puzzlepiece.extension"
        android="extension-puzzle-outline"
        size={13}
        color="#B0B0B6"
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
          backgroundColor: "#2A2A2E",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: "#C9C9CE", fontSize: 9 }}>
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
        backgroundColor: mention.color ?? "#85858A",
      }}
    />
  );
}

function previewMessageText(message: MobileMessage): string {
  const text = message.blocks
    .flatMap((block) => {
      if (block.kind === "channel_message" && block.text) {
        return [`${messagingProviderLabel(block.provider)} · ${block.fromLabel}: ${block.text}`];
      }
      return block.kind === "text" && block.text ? [block.text] : [];
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

async function speakMessage(botId: string, message: MobileMessage) {
  const text = blockText(message);
  if (!text.trim()) return;
  if (!(await speakText(text, { botId }))) {
    throw new Error(t("Add a voice provider in Voice settings."));
  }
}

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
  onPreviewMarkdown,
  onSpeak,
}: {
  botId: string;
  botName?: string;
  bots: MobileBot[];
  groupId?: string;
  message: MobileMessage;
  members?: MobileSnapshot["members"];
  replyPreview?: MobileMessage;
  canAnswer: boolean;
  onAnswer: (message: MobileMessage, answer: string) => Promise<void>;
  onOpenBot: (botId: string, name: string) => void;
  onPreviewMarkdown: (target: MarkdownArtifactPreviewTarget) => void;
  onSpeak?: (message: MobileMessage) => void;
}) {
  const { t } = useI18n();
  const [peerExpanded, setPeerExpanded] = useState(false);
  const artifactTarget: MobileArtifactTarget = groupId ? { groupId } : { botId };
  const cardBotId = message.botId ?? botId;
  const appConnectBlocks = message.blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "app_connect" }> =>
      block.kind === "app_connect",
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
          canAnswer={canAnswer}
          onAnswer={(answer) => onAnswer(message, answer)}
        />
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard key={`${block.provider}-${index}`} botId={cardBotId} block={block} />
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
      "#85858A";
    // Compact receipt only: peer bodies stay out of the human thread.
    // Full view-only peer chat is web-first; mobile keeps the chip without expand.
    return (
      <View
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
        <Text numberOfLines={1} style={{ color: "#85858A", fontSize: 13.5, flexShrink: 1 }}>
          {label}
        </Text>
      </View>
    );
  }
  const channelMessage = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "channel_message" }> =>
      block.kind === "channel_message",
  );
  if (channelMessage) {
    return (
      <View style={{ width: "100%", paddingVertical: 4, alignItems: "center" }}>
        <Text style={{ color: "#85858A", fontSize: 13.5, textAlign: "center" }}>
          {messagingProviderLabel(channelMessage.provider)} · {channelMessage.fromLabel}:{" "}
          {channelMessage.text}
        </Text>
      </View>
    );
  }
  const special = message.blocks.find(
    (block) => block.kind === "subagent" || block.kind === "child_bot",
  );
  if (special?.kind === "subagent") {
    const running = special.status === "running";
    const failed = special.status === "failed";
    return (
      <View
        style={{
          width: "90%",
          borderRadius: 18,
          borderWidth: 1,
          borderColor: "#232326",
          backgroundColor: "#17171A",
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
          <Text style={{ color: "#ECECEE", fontSize: 15, fontWeight: "600" }}>
            {special.name || t("subagent")}
          </Text>
          <Text
            style={{
              color: failed ? "#EF4444" : running ? "#F5A03C" : "#4ECB71",
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
          <Text style={{ color: "#85858A", marginTop: 8, fontSize: 13.5 }}>{special.task}</Text>
        ) : null}
        {special.result || special.progress ? (
          <View style={{ marginTop: 8 }}>
            <ChatMarkdown streaming={running}>
              {special.result || special.progress || ""}
            </ChatMarkdown>
          </View>
        ) : null}
      </View>
    );
  }
  if (special?.kind === "child_bot") {
    const removed = special.status === "deleted" || special.status === "archived";
    return (
      <Pressable
        disabled={removed}
        onPress={() => onOpenBot(special.botId ?? "", special.name ?? t("Bot"))}
        style={{
          width: "90%",
          borderRadius: 18,
          borderWidth: 1,
          borderColor: "#232326",
          backgroundColor: "#17171A",
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
          <Text style={{ color: "#ECECEE", fontSize: 15, fontWeight: "600" }}>
            {special.name || t("Bot")}
          </Text>
          <Text style={{ color: removed ? "#EF4444" : "#4ECB71", fontSize: 13 }}>
            {special.status === "archived"
              ? t("archived")
              : special.status === "deleted"
                ? t("deleted")
                : t("bot")}
          </Text>
        </View>
        <Text
          style={{
            color: "#A8A8AD",
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
  if (appConnectBlocks.length > 0 && appConnectBlocks.length === message.blocks.length) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard key={`${block.provider}-${index}`} botId={cardBotId} block={block} />
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
            borderColor: "#232326",
            backgroundColor: "#17171A",
            paddingHorizontal: 16,
            paddingVertical: 14,
          }}
        >
          {askBlock.text ? (
            <Text style={{ color: "#ECECEE", fontSize: 15.5, lineHeight: 23 }}>
              {askBlock.text}
            </Text>
          ) : null}
          {askBlock.detail ? (
            <Text
              style={{
                color: "#85858A",
                marginTop: 8,
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
              style={{
                color: "#4ECB71",
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
              onAnswer={(answer) => onAnswer(message, answer)}
            />
          ) : (
            <Text style={{ color: "#85858A", marginTop: 12, fontSize: 13.5 }}>
              {t("No longer active")}
            </Text>
          )}
        </View>
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard key={`${block.provider}-${index}`} botId={cardBotId} block={block} />
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
        return [`${messagingProviderLabel(block.provider)} · ${block.fromLabel}: ${block.text}`];
      }
      return block.kind === "text" && block.text ? [block.text] : [];
    })
    .join("\n");
  if (attachments.length > 0) {
    const speaker =
      message.role === "bot" ? (memberName(members, message.botId) ?? botName) : undefined;
    return (
      <View
        style={{
          maxWidth: "100%",
          borderRadius: 20,
          borderWidth: 1,
          borderColor: "#26262A",
          backgroundColor: message.role === "user" ? "#F1F1EF" : "#1A1A1D",
          paddingHorizontal: 14,
          paddingVertical: 12,
          gap: 8,
        }}
      >
        {speaker ? (
          <Text style={{ color: "#85858A", fontSize: 12.5, fontWeight: "600" }}>{speaker}</Text>
        ) : null}
        {replyPreview ? (
          <Text style={{ color: "#85858A", fontSize: 12.5 }} numberOfLines={2}>
            {previewMessageText(replyPreview)}
          </Text>
        ) : null}
        {caption ? (
          <Text
            style={{
              color: message.role === "user" ? "#1A1A1A" : "#DFDFE2",
              fontSize: 15,
            }}
          >
            {caption}
          </Text>
        ) : null}
        {attachments.map((attachment, index) =>
          attachment.kind === "image" ? (
            <Pressable
              key={`${attachment.artifactId ?? attachment.name ?? "image"}-${index}`}
              onPress={() =>
                attachment.artifactId
                  ? void openMobileArtifact(
                      artifactTarget,
                      attachment.artifactId,
                      attachment.name ?? t("Image"),
                      attachment.mimeType ?? "image/png",
                    ).catch((err) =>
                      Alert.alert(
                        t("Could not open image"),
                        err instanceof Error ? err.message : t("Try again."),
                      ),
                    )
                  : undefined
              }
            >
              <Text
                style={{
                  color: message.role === "user" ? "#1A1A1A" : "#DFDFE2",
                  fontSize: 15,
                }}
              >
                🖼 {attachment.name ?? t("Image")}
              </Text>
            </Pressable>
          ) : (
            <Pressable
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
                        Alert.alert(
                          t("Could not open file"),
                          err instanceof Error ? err.message : t("Try again."),
                        ),
                      )
                  : undefined
              }
            >
              <Text
                style={{
                  color: message.role === "user" ? "#1A1A1A" : "#DFDFE2",
                  fontSize: 15,
                }}
              >
                📎 {attachment.name ?? t("File")}
              </Text>
              {attachment.size ? (
                <Text style={{ color: "#85858A", marginTop: 4, fontSize: 13 }}>
                  {attachment.mimeType ?? "file"} · {attachment.size} bytes
                </Text>
              ) : null}
            </Pressable>
          ),
        )}
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard key={`${block.provider}-${index}`} botId={cardBotId} block={block} />
        ))}
      </View>
    );
  }
  const segments = messagePresentationSegments(message.blocks);
  const speaker =
    message.role === "bot" ? (memberName(members, message.botId) ?? botName) : undefined;
  const firstContent = segments.findIndex((segment) => segment.kind === "content");
  const lastContent = segments.reduce(
    (last, segment, index) => (segment.kind === "content" ? index : last),
    -1,
  );
  return (
    <View style={{ gap: 8, width: "100%" }}>
      {segments.map((segment, index) => (
        <MessageTextCard
          key={`${message.id}-content-${index}`}
          message={{ ...message, blocks: segment.blocks }}
          speaker={index === firstContent ? speaker : undefined}
          replyPreview={index === firstContent ? replyPreview : undefined}
          onSpeak={index === lastContent && onSpeak ? () => onSpeak(message) : undefined}
        />
      ))}
      {appConnectBlocks.map((block, index) => (
        <AppConnectCard key={`${block.provider}-${index}`} botId={cardBotId} block={block} />
      ))}
    </View>
  );
});

function MessageTextCard({
  message,
  speaker,
  replyPreview,
  onSpeak,
}: {
  message: MobileMessage;
  speaker?: string;
  replyPreview?: MobileMessage;
  onSpeak?: () => void;
}) {
  const { t } = useI18n();
  const contentText = blockText(message);
  if (!contentText) return null;
  return (
    <View
      style={{
        flexShrink: 1,
        minWidth: 0,
        maxWidth: "100%",
        backgroundColor: message.role === "user" ? "#F1F1EF" : "#1A1A1D",
        padding: 12,
        borderRadius: 20,
      }}
    >
      {speaker ? (
        <Text style={{ color: "#85858A", fontSize: 12.5, fontWeight: "600", marginBottom: 4 }}>
          {speaker}
        </Text>
      ) : null}
      {replyPreview ? (
        <Text style={{ color: "#85858A", fontSize: 12.5, marginBottom: 6 }} numberOfLines={2}>
          {previewMessageText(replyPreview)}
        </Text>
      ) : null}
      {message.role === "user" ? (
        <Text style={{ color: "#1A1A1A", fontSize: 15.5, lineHeight: 23 }}>{contentText}</Text>
      ) : (
        <>
          <ChatMarkdown streaming={message.id.startsWith("progress:")}>{contentText}</ChatMarkdown>
          {onSpeak ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Speak message")}
              onPress={onSpeak}
              hitSlop={8}
              style={{ marginTop: 8 }}
            >
              <Text style={{ color: "#85858A", fontSize: 13 }}>{t("Speak")}</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}

function AgentEventLabel({
  label,
  detail,
  expanded,
  onToggle,
}: {
  label: string;
  detail?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={expanded ? t("Hide {label}", { label }) : t("Show {label}", { label })}
      style={{ width: "100%", paddingVertical: 4, alignItems: "center" }}
    >
      <Text style={{ color: "#85858A", fontSize: 13.5, textAlign: "center" }}>↔ {label}</Text>
      {expanded && detail ? (
        <View
          style={{
            width: "100%",
            marginTop: 6,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: "#26262A",
            backgroundColor: "#101012",
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
        >
          <ChatMarkdown>{detail}</ChatMarkdown>
        </View>
      ) : null}
    </Pressable>
  );
}

function AskBlock({
  ask,
  canAnswer,
  onAnswer,
}: {
  ask: Extract<MobileMessage["blocks"][number], { kind: "ask" }>;
  canAnswer: boolean;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const answered = ask.status === "answered";
  const secretInput = isSecretAskBlock(ask);

  async function submit() {
    if (submitting) return;
    if (secretInput ? answer.length === 0 : !answer.trim()) return;
    const submitValue = secretInput ? answer : answer.trim();
    setSubmitting(true);
    setError(null);
    try {
      await onAnswer(submitValue);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not send answer"));
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
        borderColor: "#2D2D31",
        backgroundColor: "#17171A",
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 10,
      }}
    >
      <Text style={{ color: "#ECECEE", fontSize: 15.5, fontWeight: "600" }}>{ask.text}</Text>
      {ask.detail ? <Text style={{ color: "#85858A", fontSize: 13.5 }}>{ask.detail}</Text> : null}
      {answered ? (
        <Text style={{ color: "#4ECB71", fontSize: 14 }}>
          {secretInput
            ? t("Submitted")
            : t("Answered: {answer}", { answer: ask.answer ?? t("Done") })}
        </Text>
      ) : canAnswer ? (
        <>
          <TextInput
            accessibilityLabel={secretInput ? t("Code") : t("Answer")}
            value={answer}
            onChangeText={setAnswer}
            placeholder={secretInput ? t("Code") : t("Type your answer")}
            placeholderTextColor="#6C6C70"
            secureTextEntry={secretInput}
            autoComplete="off"
            onSubmitEditing={() => void submit()}
            style={{
              minHeight: 42,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: "#35353A",
              color: "#ECECEE",
              paddingHorizontal: 12,
              paddingVertical: 9,
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Send answer")}
            disabled={(secretInput ? answer.length === 0 : !answer.trim()) || submitting}
            onPress={() => void submit()}
            style={{
              alignSelf: "flex-end",
              borderRadius: 999,
              backgroundColor: "#ECECEE",
              opacity: (secretInput ? answer.length === 0 : !answer.trim()) || submitting ? 0.5 : 1,
              paddingHorizontal: 16,
              paddingVertical: 9,
            }}
          >
            <Text style={{ color: "#17171A", fontWeight: "600" }}>
              {submitting ? t("Sending…") : t("Send answer")}
            </Text>
          </Pressable>
        </>
      ) : (
        <Text style={{ color: "#85858A", fontSize: 13.5 }}>
          {t("Waiting for this bot’s response.")}
        </Text>
      )}
      {error ? <Text style={{ color: "#EF4444", fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}
