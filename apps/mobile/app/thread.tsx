import { ChatMarkdown } from "@rakazo/chat-ui/native";
import { abortableDelay, attachmentsForThread } from "@rakazo/core";
import { Link, useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, AppState, Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";
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

type PendingAttachment = PickedAttachment & { threadKey: string };

export default function Thread() {
  const navigation = useNavigation();
  const router = useRouter();
  const { botId, groupId, name, messageId } = useLocalSearchParams<{
    botId?: string;
    groupId?: string;
    name?: string;
    messageId?: string;
  }>();
  const inGroup = Boolean(groupId);
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
  const activeBotId = useRef(botId);
  activeBotId.current = botId;
  const activeGroupId = useRef(groupId);
  activeGroupId.current = groupId;
  const threadKey = groupId ?? botId;
  const [snap, setSnap] = useState<MobileSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [replyTarget, setReplyTarget] = useState<MobileMessage | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const activePendingAttachments = attachmentsForThread(pendingAttachments, threadKey);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: name || "Thread",
      headerRight: () =>
        inGroup ? (
          <Pressable
            accessibilityLabel="Group settings"
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
          <Pressable accessibilityLabel="Bot actions" hitSlop={8} onPress={showBotActions}>
            <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={21} color="#ECECEE" />
          </Pressable>
        ),
    });
  }, [botId, groupId, inGroup, name, navigation, router]);

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
    if (!botId && !groupId) return;
    const epoch = historyEpoch.current;
    const next = await rpc<MobileSnapshot>(
      "threads/get",
      groupId ? { groupId } : { botId: botId! },
    );
    if (!groupId && epoch !== historyEpoch.current) return next;
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
    if (AppState.currentState !== "active" || !navigation.isFocused()) return;
    if (groupId) {
      void rpc("threads/markRead", { groupId }).catch(() => undefined);
      return;
    }
    if (!botId) return;
    void rpc("threads/markRead", { botId }).catch(() => undefined);
  }, [botId, groupId, navigation]);

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
    if (!botId && !groupId) return;
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
            groupId ? { groupId } : { botId: botId! },
            cursor,
            (event) => {
              cursor = Math.max(cursor, event.seq ?? -1);
              retryMs = 250;
              if (
                event.type === "thread.progress" ||
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
  }, [botId, groupId, markReadIfVisible]);

  useEffect(() => {
    if (!botId || !messageId) return;
    void applyMessageJump(botId, messageId).catch((err) => {
      setError(err instanceof Error ? err.message : "Could not open message");
    });
  }, [botId, messageId]);

  useEffect(() => {
    setPendingAttachments((current) => attachmentsForThread(current, threadKey));
    setDraft("");
    setReplyTarget(null);
    setAttachmentNotice(null);
    setError(null);
  }, [threadKey]);

  async function send() {
    const targetBotId = botId;
    const targetGroupId = groupId;
    if ((!targetBotId && !targetGroupId) || sending) return;
    const uploadBotId = targetBotId ?? snap?.members?.[0]?.botId;
    const attachments = attachmentsForThread(pendingAttachments, threadKey);
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const artifactIds: string[] = [];
      if (attachments.length && !uploadBotId) throw new Error("No bot available for attachments");
      for (const pending of attachments) {
        const artifact = await rpc<{ id: string }>("artifacts/create", {
          botId: uploadBotId!,
          name: pending.name,
          mimeType: pending.mimeType,
          contentBase64: pending.contentBase64,
        });
        artifactIds.push(artifact.id);
      }
      await rpc(
        "threads/send",
        targetGroupId
          ? {
              groupId: targetGroupId,
              text: text || undefined,
              artifactIds: artifactIds.length ? artifactIds : undefined,
              replyToMessageId: replyTarget?.id,
            }
          : {
              botId: targetBotId!,
              text: text || undefined,
              artifactIds: artifactIds.length ? artifactIds : undefined,
              replyToMessageId: replyTarget?.id,
            },
      );
      setPendingAttachments((current) =>
        current.filter((attachment) => attachment.threadKey !== threadKey),
      );
      if (activeBotId.current === targetBotId || groupId) {
        setDraft("");
        setReplyTarget(null);
        setAttachmentNotice(null);
        await refresh();
      }
    } catch (err) {
      if (activeBotId.current === targetBotId || groupId) {
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
    const targetKey = groupId ?? botId;
    if (!targetKey) return;
    const result = await picker(activePendingAttachments.length);
    if ((groupId ?? botId) !== targetKey) return;
    if (result.attachments.length) {
      setPendingAttachments((current) => [
        ...current,
        ...result.attachments.map((attachment) => ({ ...attachment, threadKey: targetKey })),
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
        {(snap?.messages ?? []).map((message) => (
          <View
            key={message.id}
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
            <View style={{ maxWidth: "90%", flexShrink: 1 }}>
              {message.role !== "user" ? (
                <Pressable
                  accessibilityLabel="Reply"
                  onPress={() => setReplyTarget(message)}
                  style={{ alignSelf: "flex-start", marginBottom: 4 }}
                >
                  <Text style={{ color: "#6C6C70", fontSize: 12 }}>Reply</Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityLabel="Reply"
                  onPress={() => setReplyTarget(message)}
                  style={{ alignSelf: "flex-end", marginBottom: 4 }}
                >
                  <Text style={{ color: "#6C6C70", fontSize: 12 }}>Reply</Text>
                </Pressable>
              )}
              <MessageBubble
                botId={botId ?? snap?.members?.[0]?.botId ?? ""}
                message={message}
                members={snap?.members}
                replyPreview={
                  message.replyToMessageId
                    ? snap?.messages.find((row) => row.id === message.replyToMessageId)
                    : undefined
                }
                onOpenBot={(id, botName) =>
                  router.push({ pathname: "/thread", params: { botId: id, name: botName } })
                }
                onSpeak={
                  message.role === "bot"
                    ? () =>
                        void speakMessage(botId ?? snap?.members?.[0]?.botId ?? "", message).catch(
                          (err) =>
                            Alert.alert(
                              "Could not speak",
                              err instanceof Error ? err.message : "Try again.",
                            ),
                        )
                    : undefined
                }
              />
            </View>
          </View>
        ))}
      </ScrollView>
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
            <Text style={{ color: "#85858A", fontSize: 12 }}>Replying to</Text>
            <Text style={{ color: "#C9C9CE", fontSize: 13 }} numberOfLines={1}>
              {previewMessageText(replyTarget)}
            </Text>
          </View>
          <Pressable accessibilityLabel="Cancel reply" onPress={() => setReplyTarget(null)}>
            <Text style={{ color: "#85858A" }}>✕</Text>
          </Pressable>
        </View>
      ) : null}
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
          placeholder="Message…"
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
      {!inGroup ? (
        <Link
          href={{ pathname: "/computer", params: { botId: botId ?? "", name: name ?? "Bot" } }}
          asChild
        >
          <Pressable style={{ marginTop: 16 }}>
            <Text style={{ color: "#C9C9CE" }}>Open computer →</Text>
          </Pressable>
        </Link>
      ) : null}
    </View>
  );
}

function previewMessageText(message: MobileMessage): string {
  const text = message.blocks
    .filter((block) => block.kind === "text" && block.text)
    .map((block) => block.text)
    .join(" ")
    .trim();
  if (text) return text;
  if (message.blocks.some((block) => block.kind === "image" || block.kind === "file")) {
    return "Attachment";
  }
  return "Message";
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
  const prepared = await rpc<{ ready: boolean; utterances: string[] }>("voice/prepare", {
    text,
    botId,
  });
  if (!prepared.ready) throw new Error("Add a voice provider in Voice settings.");
  for (const utterance of prepared.utterances) {
    await playMpeg(await speakUtterance(utterance, { botId }));
  }
}

function MessageBubble({
  botId,
  message,
  members,
  replyPreview,
  onOpenBot,
  onSpeak,
}: {
  botId: string;
  message: MobileMessage;
  members?: MobileSnapshot["members"];
  replyPreview?: MobileMessage;
  onOpenBot: (botId: string, name: string) => void;
  onSpeak?: () => void;
}) {
  const handoff = message.blocks.find((block) => block.kind === "handoff");
  if (handoff) {
    const from = memberName(members, handoff.fromBotId) ?? "bot";
    const to = memberName(members, handoff.toBotId) ?? "bot";
    return (
      <View style={{ paddingVertical: 4 }}>
        <Text style={{ color: "#85858A", fontSize: 13.5, textAlign: "center" }}>
          ↪ {to} ← {from}
          {handoff.text ? ` · ${handoff.text}` : ""}
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
    const speaker = message.role === "bot" ? memberName(members, message.botId) : undefined;
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
  const speaker = message.role === "bot" ? memberName(members, message.botId) : undefined;
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
