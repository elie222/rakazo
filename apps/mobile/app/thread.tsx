import { ChatMarkdown } from "@rakazo/chat-ui/native";
import {
  abortableDelay,
  attachmentsForBot,
  createPendingUserMessageId,
  formatChatTimestamp,
  pendingUserMessageTextKey,
  shouldShowChatTimestamp,
  visibleReasoningSteps,
} from "@rakazo/core";
import { Link, useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Alert,
  Animated,
  AppState,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { NativeSymbol } from "../components/native-symbol";
import {
  applyMobileThreadEvent,
  blockText,
  type MobileMessage,
  type MobileMessagePage,
  type MobileSnapshot,
  mergeMobileSnapshot,
  prependMobileMessagePage,
  rpc,
  subscribeThread,
} from "../lib/api";
import { openMobileArtifact } from "../lib/artifact-open";
import { confirmDeleteBot } from "../lib/bot-lifecycle";
import {
  type PickedAttachment,
  pickDocuments,
  pickFromLibrary,
  takePhoto,
} from "../lib/pick-attachments";
import { playMpeg, speakUtterance } from "../lib/voice";

type PendingAttachment = PickedAttachment & { botId: string };

export default function Thread() {
  const navigation = useNavigation();
  const router = useRouter();
  const { botId, name, messageId } = useLocalSearchParams<{
    botId?: string;
    name?: string;
    messageId?: string;
  }>();
  const scroll = useRef<ScrollView>(null);
  const loadingOlderContent = useRef(false);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const pinnedAroundRef = useRef<{
    botId: string;
    messageId: string;
    threadId: string;
    messages: readonly MobileMessage[];
    olderCursor: number | null;
  } | null>(null);
  const jumpScrollTarget = useRef<string | null>(null);
  const enterState = useRef({ botId: "", seen: new Set<string>(), primed: false });
  const activeBotId = useRef(botId);
  activeBotId.current = botId;
  const [snap, setSnap] = useState<MobileSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [enteringIds, setEnteringIds] = useState<Set<string>>(() => new Set());
  const [channelPeerId, setChannelPeerId] = useState<string | null>(null);
  const activePendingAttachments = attachmentsForBot(pendingAttachments, botId);
  const botWorking = Boolean(
    snap?.run && ["running", "queued", "leased"].includes(snap.run.status),
  );
  const hasLiveReasoning = (snap?.messages ?? []).some((message) =>
    message.id.startsWith("reasoning:"),
  );

  useLayoutEffect(() => {
    const nextBotId = botId ?? "";
    const switchedBot = enterState.current.botId !== nextBotId;
    const next = collectEnteringUserMessageIds(nextBotId, snap?.messages ?? [], enterState.current);
    if (switchedBot) {
      setEnteringIds(new Set());
      return;
    }
    if (next.size > 0) setEnteringIds(next);
  }, [botId, snap?.messages]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: name || "Thread",
      headerRight: () => (
        <Pressable accessibilityLabel="Bot actions" hitSlop={8} onPress={showBotActions}>
          <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={21} color="#ECECEE" />
        </Pressable>
      ),
    });
  }, [botId, name, navigation]);

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
        setError(err instanceof Error ? err.message : "Could not clear conversation"),
      );
  }

  function showBotActions() {
    if (!botId) return;
    const bot = { id: botId, name: name || "Bot" };
    Alert.alert(bot.name, "Archive keeps everything and can be undone. Delete is permanent.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear conversation",
        style: "destructive",
        onPress: () => {
          Alert.alert(
            "Clear conversation?",
            "This removes every message and stops current work. The bot, computer, memory, and routines are kept.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Clear", style: "destructive", onPress: clearConversation },
            ],
          );
        },
      },
      {
        text: "Archive",
        onPress: () =>
          void rpc("bots/archive", { botId })
            .then(leaveBot)
            .catch((error) =>
              Alert.alert(
                "Could not archive bot",
                error instanceof Error ? error.message : "Try again.",
              ),
            ),
      },
      { text: "Delete…", style: "destructive", onPress: () => confirmDeleteBot(bot, leaveBot) },
    ]);
  }

  async function refresh() {
    if (!botId) return;
    const epoch = historyEpoch.current;
    const next = await rpc<MobileSnapshot>("threads/get", { botId });
    // The epoch check drops a response that raced a conversation clear, which would otherwise
    // re-apply the deleted messages and cursor over the emptied snapshot.
    if (epoch !== historyEpoch.current) return next;
    const pin = pinnedAroundRef.current;
    setSnap((prev) => {
      let merged = mergeMobileSnapshot(prev, next, expandedHistoryThread.current === next.threadId);
      if (pin && merged && pin.botId === botId) {
        merged = {
          ...merged,
          messages: [...pin.messages],
          olderCursor: pin.olderCursor,
        };
      }
      return merged;
    });
    return next;
  }

  async function applyMessageJump(targetBotId: string, targetMessageId: string) {
    const epoch = historyEpoch.current;
    const [snap, page] = await Promise.all([
      rpc<MobileSnapshot>("threads/get", { botId: targetBotId }),
      rpc<MobileMessagePage>("threads/messages", {
        botId: targetBotId,
        around: { messageId: targetMessageId },
      }),
    ]);
    // The epoch check drops a jump that raced a conversation clear (or a bot switch): applying
    // the fetched page would pin deleted messages that every later refresh keeps restoring.
    if (epoch !== historyEpoch.current) return;
    expandedHistoryThread.current = page.threadId;
    pinnedAroundRef.current = {
      botId: targetBotId,
      messageId: targetMessageId,
      threadId: page.threadId,
      messages: [...page.messages],
      olderCursor: page.olderCursor,
    };
    jumpScrollTarget.current = targetMessageId;
    setSnap({
      ...snap,
      messages: [...page.messages],
      olderCursor: page.olderCursor,
    });
  }

  async function loadOlderMessages() {
    if (!botId || snap?.olderCursor == null || loadingOlder) return;
    pinnedAroundRef.current = null;
    jumpScrollTarget.current = null;
    loadingOlderContent.current = true;
    setLoadingOlder(true);
    const epoch = historyEpoch.current;
    try {
      const page = await rpc<MobileMessagePage>("threads/messages", {
        botId,
        before: snap.olderCursor,
      });
      if (epoch !== historyEpoch.current) {
        loadingOlderContent.current = false;
        return;
      }
      expandedHistoryThread.current = page.threadId;
      setSnap((prev) => prependMobileMessagePage(prev, page));
    } catch (err) {
      loadingOlderContent.current = false;
      setError(err instanceof Error ? err.message : "Could not load earlier messages");
    } finally {
      setLoadingOlder(false);
    }
  }

  const markReadIfVisible = useCallback(() => {
    if (!botId || AppState.currentState !== "active" || !navigation.isFocused()) return;
    void rpc("threads/markRead", { botId }).catch(() => undefined);
  }, [botId, navigation]);

  // Covers returning from a pushed screen; the AppState listener covers returning from background.
  useFocusEffect(
    useCallback(() => {
      markReadIfVisible();
    }, [markReadIfVisible]),
  );

  useEffect(() => {
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") markReadIfVisible();
    });
    return () => appState.remove();
  }, [markReadIfVisible]);

  useEffect(() => {
    if (!botId) return;
    if (!messageId) {
      pinnedAroundRef.current = null;
      jumpScrollTarget.current = null;
    }
    expandedHistoryThread.current = null;
    historyEpoch.current += 1;
    const abort = new AbortController();
    void (async () => {
      const next = await refresh().catch((err: Error) => {
        setError(err.message);
        return null;
      });
      if (abort.signal.aborted) return;
      let cursor = next?.cursor ?? -1;
      let retryMs = 250;
      while (!abort.signal.aborted) {
        try {
          await subscribeThread(
            botId,
            cursor,
            (event) => {
              cursor = Math.max(cursor, event.seq ?? -1);
              retryMs = 250;
              if (
                event.type === "thread.progress" ||
                event.type === "thread.reasoning" ||
                event.type === "thread.message.created" ||
                event.type === "thread.message.updated" ||
                event.type === "thread.subagent" ||
                event.type === "thread.cleared" ||
                event.type === "run.waiting_input"
              ) {
                if (event.type === "thread.cleared") {
                  expandedHistoryThread.current = null;
                  pinnedAroundRef.current = null;
                  historyEpoch.current += 1;
                }
                setSnap((prev) => applyMobileThreadEvent(prev, event));
              }
              if (event.type === "thread.message.created" && event.payload?.role === "bot") {
                markReadIfVisible();
              }
              if (event.type === "run.completed") {
                void refresh().catch(() => undefined);
              }
            },
            abort.signal,
          );
        } catch {
          // A full refresh reconciles visible state; the event cursor still resumes without gaps.
        }
        if (abort.signal.aborted) break;
        await refresh().catch(() => undefined);
        await abortableDelay(retryMs, abort.signal);
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    })();
    return () => {
      abort.abort();
    };
  }, [botId, markReadIfVisible]);

  useEffect(() => {
    if (!botId || !messageId) return;
    void applyMessageJump(botId, messageId).catch((err) => {
      setError(err instanceof Error ? err.message : "Could not open message");
    });
  }, [botId, messageId]);

  useEffect(() => {
    setPendingAttachments((current) => attachmentsForBot(current, botId));
    setDraft("");
    setAttachmentNotice(null);
    setError(null);
  }, [botId]);

  async function send() {
    const targetBotId = botId;
    if (!targetBotId || sending) return;
    const attachments = attachmentsForBot(pendingAttachments, targetBotId);
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    const pendingId = createPendingUserMessageId();
    if (text) {
      setDraft("");
      setSnap((current) => {
        if (!current) return current;
        return {
          ...current,
          messages: [
            ...current.messages,
            { id: pendingId, role: "user", blocks: [{ kind: "text", text }] },
          ],
        };
      });
    }
    setSending(true);
    setError(null);
    try {
      const artifactIds: string[] = [];
      for (const pending of attachments) {
        const artifact = await rpc<{ id: string }>("artifacts/create", {
          botId: targetBotId,
          name: pending.name,
          mimeType: pending.mimeType,
          contentBase64: pending.contentBase64,
        });
        artifactIds.push(artifact.id);
      }
      await rpc("threads/send", {
        botId: targetBotId,
        text: text || undefined,
        artifactIds: artifactIds.length ? artifactIds : undefined,
      });
      setPendingAttachments((current) =>
        current.filter((attachment) => attachment.botId !== targetBotId),
      );
      if (activeBotId.current === targetBotId) {
        if (!text) setDraft("");
        setAttachmentNotice(null);
      }
    } catch (err) {
      if (activeBotId.current === targetBotId) {
        setSnap((current) =>
          current
            ? {
                ...current,
                messages: current.messages.filter((message) => message.id !== pendingId),
              }
            : current,
        );
        if (text) setDraft(text);
        setError(err instanceof Error ? err.message : "Failed to send message");
      }
    } finally {
      setSending(false);
    }
  }

  function showAttachMenu() {
    Alert.alert("Attach", undefined, [
      { text: "Photo library", onPress: () => void addAttachments(pickFromLibrary) },
      { text: "Camera", onPress: () => void addAttachments(takePhoto) },
      { text: "File", onPress: () => void addAttachments(pickDocuments) },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  async function addAttachments(
    picker: (existingCount: number) => Promise<{
      attachments: PickedAttachment[];
      skipped: Array<{ name: string; reason: string }>;
    }>,
  ) {
    const targetBotId = botId;
    if (!targetBotId) return;
    const result = await picker(activePendingAttachments.length);
    if (activeBotId.current !== targetBotId) return;
    if (result.attachments.length) {
      setPendingAttachments((current) => [
        ...current,
        ...result.attachments.map((attachment) => ({ ...attachment, botId: targetBotId })),
      ]);
    }
    setAttachmentNotice(
      result.skipped.length
        ? `Skipped ${result.skipped.map((item) => `${item.name} (${item.reason})`).join(", ")}`
        : null,
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000", paddingHorizontal: 20, paddingBottom: 24 }}>
      {error ? <Text style={{ color: "#8E8E93", marginTop: 12 }}>{error}</Text> : null}
      <ScrollView
        ref={scroll}
        style={{ flex: 1, marginTop: 8 }}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onContentSizeChange={() => {
          if (loadingOlderContent.current) {
            loadingOlderContent.current = false;
            return;
          }
          if (
            jumpScrollTarget.current ||
            (pinnedAroundRef.current && pinnedAroundRef.current.botId === botId)
          )
            return;
          scroll.current?.scrollToEnd({ animated: false });
        }}
      >
        {snap?.olderCursor != null ? (
          <Pressable
            disabled={loadingOlder}
            onPress={() => void loadOlderMessages()}
            style={{ alignSelf: "center", paddingHorizontal: 12, paddingVertical: 10 }}
          >
            <Text style={{ color: "#85858A", fontSize: 13 }}>
              {loadingOlder ? "Loading…" : "Load earlier messages"}
            </Text>
          </Pressable>
        ) : null}
        {(snap?.messages ?? []).map((message, index, list) => (
          <View key={message.id}>
            {message.createdAt &&
            shouldShowChatTimestamp(list[index - 1]?.createdAt, message.createdAt) ? (
              <Text
                style={{
                  color: "#6C6C70",
                  fontSize: 12.5,
                  textAlign: "center",
                  marginTop: 10,
                  marginBottom: 2,
                }}
              >
                {formatChatTimestamp(message.createdAt)}
              </Text>
            ) : null}
            <DropInMessage active={enteringIds.has(message.id)}>
              <View
                onLayout={(event) => {
                  if (jumpScrollTarget.current !== message.id) return;
                  scroll.current?.scrollTo({
                    y: Math.max(0, event.nativeEvent.layout.y - 24),
                    animated: true,
                  });
                  jumpScrollTarget.current = null;
                }}
                style={{
                  marginTop: 12,
                  width: "100%",
                  flexDirection: "row",
                  justifyContent: message.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <MessageBubble
                  botId={botId ?? ""}
                  message={message}
                  onOpenBot={(id, botName) =>
                    router.push({ pathname: "/thread", params: { botId: id, name: botName } })
                  }
                  onOpenChannel={(peerBotId) => setChannelPeerId(peerBotId)}
                  onSpeak={
                    message.role === "bot"
                      ? () =>
                          void speakMessage(botId ?? "", message).catch((err) =>
                            Alert.alert(
                              "Could not speak",
                              err instanceof Error ? err.message : "Try again.",
                            ),
                          )
                      : undefined
                  }
                />
              </View>
            </DropInMessage>
          </View>
        ))}
        {botWorking && !hasLiveReasoning ? <BotWorkingStatus /> : null}
      </ScrollView>
      {attachmentNotice ? (
        <Text style={{ color: "#D6CFA0", marginTop: 12, fontSize: 13 }}>{attachmentNotice}</Text>
      ) : null}
      {activePendingAttachments.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
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
                accessibilityLabel={`Remove ${attachment.name}`}
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
      <View style={{ flexDirection: "row", gap: 8, marginTop: 16 }}>
        <Pressable
          accessibilityLabel="Attach file"
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
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={name ? `Message ${name}` : "Message…"}
          placeholderTextColor="#6C6C70"
          keyboardAppearance="dark"
          returnKeyType="send"
          onSubmitEditing={() => void send()}
          style={{
            flex: 1,
            color: "#ECECEE",
            backgroundColor: "#131315",
            borderRadius: 20,
            paddingHorizontal: 14,
            height: 44,
          }}
        />
        <Pressable
          disabled={sending || (!draft.trim() && activePendingAttachments.length === 0)}
          onPress={() => void send()}
          style={{
            backgroundColor: "#F1F1EF",
            borderRadius: 22,
            width: 44,
            height: 44,
            alignItems: "center",
            justifyContent: "center",
            opacity: sending || (!draft.trim() && activePendingAttachments.length === 0) ? 0.5 : 1,
          }}
        >
          <NativeSymbol ios="arrow.up" android="arrow-up" size={18} color="#17171A" />
        </Pressable>
      </View>
      <Link
        href={{ pathname: "/computer", params: { botId: botId ?? "", name: name ?? "Bot" } }}
        asChild
      >
        <Pressable style={{ marginTop: 16 }}>
          <Text style={{ color: "#C9C9CE" }}>Open computer →</Text>
        </Pressable>
      </Link>
      {channelPeerId && botId ? (
        <MobileBotChannel
          botId={botId}
          peerBotId={channelPeerId}
          onClose={() => setChannelPeerId(null)}
        />
      ) : null}
    </View>
  );
}

function collectEnteringUserMessageIds(
  botId: string,
  messages: MobileMessage[],
  state: { botId: string; seen: Set<string>; primed: boolean },
) {
  if (state.botId !== botId) {
    state.botId = botId;
    state.seen = new Set(messages.map((message) => message.id));
    state.primed = messages.length > 0;
    return new Set<string>();
  }
  if (!state.primed) {
    if (!messages.length) return new Set<string>();
    for (const message of messages) state.seen.add(message.id);
    state.primed = true;
    return new Set<string>();
  }
  const recent = new Set(messages.slice(-4).map((message) => message.id));
  const entering = new Set<string>();
  for (const message of messages) {
    const text = userMessagePlainText(message);
    const pendingKey = pendingUserMessageTextKey(text);
    if (
      !state.seen.has(message.id) &&
      message.role === "user" &&
      recent.has(message.id) &&
      !message.blocks.some((block) => block.kind === "bot_message")
    ) {
      const replacingPending = !message.id.startsWith("pending:") && state.seen.has(pendingKey);
      if (!replacingPending) entering.add(message.id);
    }
    state.seen.add(message.id);
    if (message.role === "user") {
      if (message.id.startsWith("pending:")) state.seen.add(pendingKey);
      else state.seen.delete(pendingKey);
    }
  }
  return entering;
}

function userMessagePlainText(message: MobileMessage): string {
  return message.blocks
    .flatMap((block) => (block.kind === "text" ? [block.text ?? ""] : []))
    .join("\n");
}

function DropInMessage({ active, children }: { active: boolean; children: ReactNode }) {
  const progress = useRef(new Animated.Value(active ? 0 : 1)).current;
  useEffect(() => {
    if (!active) return;
    progress.setValue(0);
    Animated.spring(progress, {
      toValue: 1,
      friction: 6.4,
      tension: 148,
      useNativeDriver: true,
    }).start();
  }, [active, progress]);
  if (!active) return <>{children}</>;
  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [
          {
            translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [-14, 0] }),
          },
          {
            scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }),
          },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

function WorkingShimmerText({ text }: { text: string }) {
  const shine = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(shine, { toValue: 1, duration: 980, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [shine]);
  const opacity = shine.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.42, 1, 0.42],
  });
  return (
    <Animated.Text style={{ color: "#E8E8EC", fontSize: 15, fontWeight: "600", opacity }}>
      {text}
    </Animated.Text>
  );
}

function BotWorkingStatus() {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}>
      <NativeSymbol ios="chevron.right" android="chevron-forward" size={14} color="#8E8EA0" />
      <WorkingShimmerText text="Thinking" />
    </View>
  );
}

async function speakMessage(botId: string, message: MobileMessage) {
  const text = blockText(message);
  if (!text.trim()) return;
  const prepared = await rpc<{ ready: boolean; utterances: string[] }>("voice/prepare", {
    text,
    botId,
  });
  if (!prepared.ready) throw new Error("Add a voice provider in Voice settings.");
  for (const utterance of prepared.utterances) {
    await playMpeg(await speakUtterance(utterance, { botId }));
  }
}

function ReasoningCard({
  steps,
}: {
  steps: Array<{
    id?: string;
    kind?: "status" | "think" | "tool";
    title?: string;
    detail?: string;
    status?: "running" | "done";
  }>;
}) {
  const running = steps.some((step) => step.status === "running");
  const [open, setOpen] = useState(running);
  const rotation = useRef(new Animated.Value(running ? 1 : 0)).current;
  const visible = visibleReasoningSteps(
    steps.flatMap((step, index) => {
      if (step.kind !== "status" && step.kind !== "think" && step.kind !== "tool") return [];
      if (step.status !== "running" && step.status !== "done") return [];
      return [
        {
          id: step.id || String(index),
          kind: step.kind,
          title: step.title ?? "",
          detail: step.detail,
          status: step.status,
        },
      ];
    }),
  );
  useEffect(() => {
    setOpen(running);
  }, [running]);
  useEffect(() => {
    Animated.timing(rotation, {
      toValue: open ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [open, rotation]);
  return (
    <View>
      <Pressable
        onPress={() => setOpen((current) => !current)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 }}
      >
        <Animated.View
          style={{
            transform: [
              {
                rotate: rotation.interpolate({
                  inputRange: [0, 1],
                  outputRange: ["0deg", "90deg"],
                }),
              },
            ],
          }}
        >
          <NativeSymbol ios="chevron.right" android="chevron-forward" size={14} color="#8E8EA0" />
        </Animated.View>
        {running ? (
          <WorkingShimmerText text="Thinking" />
        ) : (
          <Text style={{ color: "#B4B4B8", fontSize: 15, fontWeight: "600" }}>Thought</Text>
        )}
      </Pressable>
      {open && visible.length ? (
        <View
          style={{
            marginLeft: 7,
            marginTop: 8,
            borderLeftWidth: 1,
            borderLeftColor: "#3A3A40",
            paddingLeft: 14,
            gap: 10,
          }}
        >
          {visible.map((step) => (
            <View key={step.id}>
              {step.kind === "tool" || !step.detail ? (
                <Text
                  style={{
                    color: step.status === "running" ? "#D0D0D4" : "#8E8EA0",
                    fontSize: 14,
                    lineHeight: 21,
                  }}
                >
                  {step.title}
                </Text>
              ) : null}
              {step.detail ? (
                <Text style={{ color: "#8E8EA0", fontSize: 14, lineHeight: 21 }}>
                  {step.detail}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function MessageBubble({
  botId,
  message,
  onOpenBot,
  onSpeak,
  onOpenChannel,
}: {
  botId: string;
  message: MobileMessage;
  onOpenBot: (botId: string, name: string) => void;
  onSpeak?: () => void;
  onOpenChannel: (peerBotId: string) => void;
}) {
  const botMessage = message.blocks.find((block) => block.kind === "bot_message");
  if (botMessage?.kind === "bot_message" && botMessage.peerBotId) {
    return (
      <MobileBotMessageChip
        direction={botMessage.direction === "out" ? "out" : "in"}
        name={botMessage.peerName || "Bot"}
        color={botMessage.peerColor || "#3EC5A8"}
        text={botMessage.text || ""}
        onOpen={() => onOpenChannel(botMessage.peerBotId!)}
      />
    );
  }
  const reasoning = message.blocks.find((block) => block.kind === "reasoning");
  const special = message.blocks.find(
    (block) => block.kind === "subagent" || block.kind === "child_bot",
  );
  if (reasoning?.kind === "reasoning" && reasoning.steps?.length && !special) {
    const textBlocks = message.blocks.filter(
      (block) => (block.kind === "text" || block.kind === "progress") && block.text,
    );
    return (
      <View style={{ gap: 8, maxWidth: "90%" }}>
        <ReasoningCard steps={reasoning.steps} />
        {textBlocks.length ? (
          <View
            style={{
              backgroundColor: "#1A1A1D",
              padding: 12,
              borderRadius: 20,
            }}
          >
            <ChatMarkdown streaming={message.id.startsWith("progress:")}>
              {textBlocks.map((block) => block.text).join("\n")}
            </ChatMarkdown>
          </View>
        ) : null}
      </View>
    );
  }
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
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          <Text style={{ color: "#ECECEE", fontSize: 15, fontWeight: "600" }}>
            {special.name || "subagent"}
          </Text>
          <Text
            style={{ color: failed ? "#E65707" : running ? "#F5A03C" : "#4ECB71", fontSize: 13 }}
          >
            {running ? "subagent" : special.status}
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
        onPress={() => onOpenBot(special.botId ?? "", special.name ?? "Bot")}
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
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          <Text style={{ color: "#ECECEE", fontSize: 15, fontWeight: "600" }}>
            {special.name || "Bot"}
          </Text>
          <Text style={{ color: removed ? "#E65707" : "#4ECB71", fontSize: 13 }}>
            {special.status === "archived"
              ? "archived"
              : special.status === "deleted"
                ? "deleted"
                : "bot"}
          </Text>
        </View>
        <Text style={{ color: "#A8A8AD", marginTop: 8, fontSize: 14.5, lineHeight: 21 }}>
          {removed
            ? special.status === "archived"
              ? "Archived this bot. Its chat, memory, and files are preserved."
              : "Removed this bot, including its chat, computer, and memory."
            : special.title || "Opened its own thread. Tap to switch."}
        </Text>
      </Pressable>
    );
  }
  const attachments = message.blocks.filter(
    (block) => block.kind === "image" || block.kind === "file",
  );
  const caption = message.blocks
    .filter((block) => block.kind === "text" && block.text)
    .map((block) => block.text)
    .join("\n");
  if (attachments.length > 0) {
    return (
      <View
        style={{
          maxWidth: "85%",
          borderRadius: 20,
          borderWidth: 1,
          borderColor: "#26262A",
          backgroundColor: message.role === "user" ? "#F1F1EF" : "#1A1A1D",
          paddingHorizontal: 14,
          paddingVertical: 12,
          gap: 8,
        }}
      >
        {caption ? (
          <Text style={{ color: message.role === "user" ? "#1A1A1A" : "#DFDFE2", fontSize: 15 }}>
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
                      botId,
                      attachment.artifactId,
                      attachment.name ?? "Image",
                      attachment.mimeType ?? "image/png",
                    ).catch((err) =>
                      Alert.alert(
                        "Could not open image",
                        err instanceof Error ? err.message : "Try again.",
                      ),
                    )
                  : undefined
              }
            >
              <Text
                style={{ color: message.role === "user" ? "#1A1A1A" : "#DFDFE2", fontSize: 15 }}
              >
                🖼 {attachment.name ?? "Image"}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              key={`${attachment.artifactId ?? attachment.name ?? "file"}-${index}`}
              onPress={() =>
                attachment.artifactId
                  ? void openMobileArtifact(
                      botId,
                      attachment.artifactId,
                      attachment.name ?? "File",
                      attachment.mimeType ?? "text/plain",
                    ).catch((err) =>
                      Alert.alert(
                        "Could not open file",
                        err instanceof Error ? err.message : "Try again.",
                      ),
                    )
                  : undefined
              }
            >
              <Text
                style={{ color: message.role === "user" ? "#1A1A1A" : "#DFDFE2", fontSize: 15 }}
              >
                📎 {attachment.name ?? "File"}
              </Text>
              {attachment.size ? (
                <Text style={{ color: "#85858A", marginTop: 4, fontSize: 13 }}>
                  {attachment.mimeType ?? "file"} · {attachment.size} bytes
                </Text>
              ) : null}
            </Pressable>
          ),
        )}
      </View>
    );
  }
  return (
    <View
      style={{
        flexShrink: 1,
        minWidth: 0,
        maxWidth: "85%",
        backgroundColor: message.role === "user" ? "#F1F1EF" : "#1A1A1D",
        padding: 12,
        borderRadius: 20,
      }}
    >
      {message.role === "user" ? (
        <Text style={{ color: "#1A1A1A", fontSize: 15.5, lineHeight: 23 }}>
          {blockText(message)}
        </Text>
      ) : (
        <>
          <ChatMarkdown streaming={message.id.startsWith("progress:")}>
            {blockText(message)}
          </ChatMarkdown>
          {onSpeak ? (
            <Pressable onPress={onSpeak} hitSlop={8} style={{ marginTop: 8 }}>
              <Text style={{ color: "#85858A", fontSize: 13 }}>Speak</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}

function MobileBotMessageChip({
  direction,
  name,
  color,
  text,
  onOpen,
}: {
  direction: "in" | "out";
  name: string;
  color: string;
  text: string;
  onOpen: () => void;
}) {
  if (direction === "out") {
    return (
      <Pressable onPress={onOpen} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ color: "#8E8EA0", fontSize: 14 }}>Messaged</Text>
        <BotAvatar color={color} size={16} />
        <Text style={{ color: "#C9C9CE", fontSize: 14, fontWeight: "600" }}>{name}</Text>
      </Pressable>
    );
  }
  return (
    <View style={{ gap: 8, maxWidth: "90%" }}>
      <Pressable
        onPress={onOpen}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }}
      >
        <Text style={{ color: "#8E8EA0", fontSize: 13 }}>Message from</Text>
        <BotAvatar color={color} size={16} />
        <Text style={{ color: "#C9C9CE", fontSize: 13, fontWeight: "600" }}>{name}</Text>
      </Pressable>
      <View style={{ backgroundColor: "#1A1A1D", padding: 12, borderRadius: 20 }}>
        <Text style={{ color: "#DFDFE2", fontSize: 15, lineHeight: 22 }}>{text}</Text>
      </View>
    </View>
  );
}

function MobileBotChannel({
  botId,
  peerBotId,
  onClose,
}: {
  botId: string;
  peerBotId: string;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<{
    left: { id: string; name: string; color: string };
    right: { id: string; name: string; color: string };
    messages: Array<{ id: string; fromBotId: string; text: string; createdAt?: string }>;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void rpc<{
      left: { id: string; name: string; color: string };
      right: { id: string; name: string; color: string };
      messages: Array<{ id: string; fromBotId: string; text: string; createdAt?: string }>;
    }>("threads/channel", { botId, peerBotId })
      .then((next) => {
        if (!cancelled) setChannel(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not open chat");
      });
    return () => {
      cancelled = true;
    };
  }, [botId, peerBotId]);
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        backgroundColor: "#0D0D0E",
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: 24,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        {channel ? (
          <View
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingRight: 12,
            }}
          >
            <Text style={{ color: "#ECECEE", fontSize: 16, fontWeight: "600" }} numberOfLines={1}>
              {channel.left.name}
            </Text>
            <NativeSymbol ios="link" android="link" size={14} color="#6C6C70" />
            <Text style={{ color: "#ECECEE", fontSize: 16, fontWeight: "600" }} numberOfLines={1}>
              {channel.right.name}
            </Text>
          </View>
        ) : (
          <Text style={{ color: "#85858A", fontSize: 16 }}>Opening chat…</Text>
        )}
        <Pressable onPress={onClose} hitSlop={8}>
          <NativeSymbol ios="xmark" android="close" size={18} color="#C9C9CE" />
        </Pressable>
      </View>
      <ScrollView style={{ flex: 1, marginTop: 16 }}>
        {error ? <Text style={{ color: "#85858A" }}>{error}</Text> : null}
        {channel && channel.messages.length === 0 && !error ? (
          <Text style={{ color: "#6C6C70", textAlign: "center", marginTop: 48 }}>
            No messages yet.
          </Text>
        ) : null}
        {channel?.messages.map((entry, index) => {
          const from = entry.fromBotId === channel.left.id ? channel.left : channel.right;
          const stamp =
            entry.createdAt &&
            shouldShowChatTimestamp(channel.messages[index - 1]?.createdAt, entry.createdAt)
              ? formatChatTimestamp(entry.createdAt)
              : "";
          return (
            <View key={entry.id} style={{ marginBottom: 14 }}>
              {stamp ? (
                <Text
                  style={{
                    color: "#6C6C70",
                    fontSize: 12.5,
                    textAlign: "center",
                    marginBottom: 10,
                  }}
                >
                  {stamp}
                </Text>
              ) : null}
              <View style={{ flexDirection: "row", gap: 8 }}>
                <BotAvatar color={from.color} size={28} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#8E8EA0", fontSize: 13, marginBottom: 4 }}>
                    {from.name}
                  </Text>
                  <View style={{ backgroundColor: "#1A1A1D", padding: 12, borderRadius: 18 }}>
                    <Text style={{ color: "#DFDFE2", fontSize: 15, lineHeight: 22 }}>
                      {entry.text}
                    </Text>
                  </View>
                </View>
              </View>
            </View>
          );
        })}
      </ScrollView>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <NativeSymbol ios="lock.fill" android="lock-closed" size={13} color="#85858A" />
          <Text style={{ color: "#85858A", fontSize: 13.5 }}>This chat is view-only</Text>
        </View>
        <Pressable
          onPress={onClose}
          style={{
            backgroundColor: "#F1F1EF",
            borderRadius: 10,
            paddingHorizontal: 14,
            paddingVertical: 8,
          }}
        >
          <Text style={{ color: "#17171A", fontWeight: "600" }}>Close Chat</Text>
        </Pressable>
      </View>
    </View>
  );
}
