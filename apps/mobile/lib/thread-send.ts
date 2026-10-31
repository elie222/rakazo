import type { LoginFieldInput, MessageReaction } from "@rakazo/contracts";
import type { SlashActionId } from "@rakazo/core";
import { attachmentsForThread, newClientId, resolveComposerSendPlan } from "@rakazo/core";
import { useNavigation, useRouter } from "expo-router";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import type { ThreadComposerHandle } from "../components/thread-composer";
import type { MobileBot, MobileMessage, MobileSnapshot } from "./api";
import { currentApiBase, loadSessionToken, rpc, selectedSpaceId } from "./api";
import { findSwitchTarget } from "./bot-switch";
import { chatSettingsRoute } from "./chat-settings-route";
import { cancelFocusPrompt } from "./focus-prompt";
import { useI18n } from "./i18n";
import { resumeLiveNotifications } from "./live-notifications";
import { currentSessionGeneration } from "./session";
import { answerThreadMessage } from "./thread-answer";
import type { useThreadAttachments } from "./thread-attachments";
import type { SendAttempt, useThreadFeedback } from "./thread-feedback";
import { subscribeDelivered } from "./thread-feedback";
import type { ThreadHistory } from "./thread-history";
import type { ThreadListScroll } from "./thread-list-scroll";
import { previewMessageText } from "./thread-message-text";
import { prepareUnsentSends } from "./unsent-sends";
import { errorText } from "./user-error";

/**
 * What the chat sends: composer messages with their reply and attachments, retries, stopping
 * work, ask answers and reactions, and slash actions.
 */
export function useThreadSend({
  botId,
  groupId,
  readOnly,
  threadKey,
  history,
  scroll,
  feedback,
  attachments,
  mentionBotsRef,
  activeBotId,
  activeGroupId,
  isCurrentTarget,
  refresh,
  showLatest,
  markCaughtUp,
  openBotChat,
}: {
  botId?: string;
  groupId?: string;
  readOnly: boolean;
  threadKey: string | undefined;
  history: ThreadHistory;
  scroll: ThreadListScroll;
  feedback: ReturnType<typeof useThreadFeedback>;
  attachments: ReturnType<typeof useThreadAttachments>;
  mentionBotsRef: RefObject<MobileBot[]>;
  activeBotId: RefObject<string | undefined>;
  activeGroupId: RefObject<string | undefined>;
  isCurrentTarget: (botId: string | undefined, groupId: string | undefined) => boolean;
  refresh: () => Promise<MobileSnapshot | undefined>;
  showLatest: () => void;
  /** Clears the "New" divider: the user has caught up. */
  markCaughtUp: () => void;
  openBotChat: (target: MobileBot, ring: boolean) => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const navigation = useNavigation();
  const { pendingAttachments, setPendingAttachments, setAttachmentNotice, importingShare } =
    attachments;
  const { setError } = feedback;
  const composerRef = useRef<ThreadComposerHandle>(null);
  const [replyTarget, setReplyTarget] = useState<MobileMessage | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const [quoteTarget, setQuoteTarget] = useState<MobileMessage | null>(null);
  const [sending, setSending] = useState(false);
  const preparingSend = useRef(false);

  useEffect(() => {
    setPendingAttachments((current) => attachmentsForThread(current, threadKey));
    setReplyTarget(null);
    setReplyQuote(null);
    setQuoteTarget(null);
    setAttachmentNotice(null);
    setError(null);
  }, [threadKey]);

  function runSlashAction(action: SlashActionId) {
    if (action === "chat-settings") {
      const settings = chatSettingsRoute({ groupId, botId });
      if (settings) router.push(settings);
      return;
    }
    router.push({
      pathname: "/account",
      params: action === "settings-usage" ? { focus: "usage" } : undefined,
    });
  }

  function followOwnSend() {
    // Writing in the chat means the user has caught up, so the "New" divider goes.
    markCaughtUp();
    if (history.pinnedAroundRef.current || history.jumpScrollTarget.current) showLatest();
    scroll.follow(scroll.behavior.current.onOwnSend());
  }

  async function send() {
    if (readOnly || importingShare.current) return;
    const initialBotTarget = botId;
    const initialGroupTarget = groupId;
    if ((!initialBotTarget && !initialGroupTarget) || sending || preparingSend.current) return;
    const originThreadKey = initialGroupTarget ?? initialBotTarget;
    const submitted = composerRef.current?.snapshot();
    if (!submitted) return;
    const attachments = attachmentsForThread(pendingAttachments, originThreadKey);
    const plan = resolveComposerSendPlan({
      text: submitted.promptText,
      mentions: submitted.mentions,
      hasAttachments: attachments.length > 0,
    });
    if (plan.isNoOp) return;
    const typedSwitch =
      initialBotTarget && attachments.length === 0
        ? findSwitchTarget(plan.trimmed, mentionBotsRef.current)
        : undefined;
    if (typedSwitch && typedSwitch.id !== initialBotTarget) {
      openBotChat(typedSwitch, false);
      return;
    }
    preparingSend.current = true;
    try {
      await prepareUnsentSends();
    } catch (error) {
      Alert.alert(t("Failed to send message"), errorText(error));
      return;
    } finally {
      preparingSend.current = false;
    }
    if (
      !isCurrentTarget(initialBotTarget, initialGroupTarget) ||
      JSON.stringify(submitted) !== JSON.stringify(composerRef.current?.snapshot())
    )
      return;
    const reroutedToGroup = Boolean(
      plan.rerouteGroupId && plan.rerouteGroupId !== initialGroupTarget,
    );
    const groupTarget = plan.rerouteGroupId ?? initialGroupTarget;
    const botTarget = reroutedToGroup ? undefined : initialBotTarget;
    let attempt: SendAttempt;
    try {
      attempt = feedback.sendAttempt({
        originThreadKey: originThreadKey!,
        displayText: submitted.promptText,
        replyPreview: replyQuote ?? (replyTarget ? previewMessageText(replyTarget) : null),
        initialBotTarget,
        botTarget,
        groupTarget,
        reroutedToGroup,
        plan,
        attachments,
        replyTargetId: replyTarget?.id,
        replyQuote,
      });
    } catch (error) {
      Alert.alert(t("Failed to send message"), errorText(error));
      return;
    }
    composerRef.current?.reset();
    setPendingAttachments((current) =>
      current.filter((attachment) => !submitted.attachmentIds.includes(attachment.id)),
    );
    setReplyTarget(null);
    setReplyQuote(null);
    setAttachmentNotice(null);
    followOwnSend();
    await deliver(attempt);
  }

  async function deliver(attempt: SendAttempt, force = false) {
    if (!readOnly) await feedback.send(attempt, force);
  }

  function retry(attempt: SendAttempt) {
    followOwnSend();
    void deliver(attempt, true);
  }

  function afterDelivered(attempt: SendAttempt) {
    const { initialBotTarget, botTarget, groupTarget, reroutedToGroup, plan } = attempt.payload;
    if (initialBotTarget) cancelFocusPrompt(initialBotTarget);
    const generation = currentSessionGeneration();
    const apiBase = currentApiBase();
    const spaceId = selectedSpaceId();
    void loadSessionToken()
      .then((token) => {
        if (
          generation === currentSessionGeneration() &&
          apiBase === currentApiBase() &&
          spaceId === selectedSpaceId()
        )
          return resumeLiveNotifications(apiBase, token, spaceId ?? "");
      })
      .catch(() => undefined);
    if (
      attempt.payload.originThreadKey !== (activeGroupId.current ?? activeBotId.current) ||
      !navigation.isFocused()
    )
      return;
    if (reroutedToGroup && groupTarget) {
      router.push({
        pathname: "/group-thread",
        params: { groupId: groupTarget, name: plan.rerouteGroupName ?? t("Group") },
      });
      return;
    }
    if (isCurrentTarget(botTarget, groupTarget)) {
      if (history.pinnedAroundRef.current) showLatest();
      void refresh().catch(() => undefined);
    }
  }

  const afterDeliveredRef = useRef(afterDelivered);
  afterDeliveredRef.current = afterDelivered;
  useEffect(() => subscribeDelivered((attempt) => afterDeliveredRef.current(attempt)), []);

  async function stop() {
    if (readOnly) return;
    const targetBotId = botId;
    const targetGroupId = groupId;
    if ((!targetBotId && !targetGroupId) || sending) return;
    setSending(true);
    try {
      await rpc(
        "threads/stop",
        targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! },
      );
    } catch (err) {
      if (isCurrentTarget(targetBotId, targetGroupId)) {
        Alert.alert(t("Failed to stop work"), errorText(err, t("Try again.")));
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

  const answer = useCallback(
    (
      message: MobileMessage,
      answer: string,
      fields?: readonly LoginFieldInput[],
      dismiss?: boolean,
      remember?: false,
    ) =>
      answerThreadMessage(
        { botId, groupId, readOnly, rpc, isCurrentTarget, refresh, markRead: markCaughtUp },
        message,
        answer,
        fields,
        dismiss,
        remember,
      ),
    [botId, groupId, readOnly],
  );

  async function react(message: MobileMessage, reaction: MessageReaction) {
    if (readOnly) return false;
    const targetBotId = botId;
    const targetGroupId = groupId;
    if (!targetBotId && !targetGroupId) return false;
    try {
      const result = await rpc("threads/react", {
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        messageId: message.id,
        reaction,
        clientNonce: newClientId(),
      });
      if (result.runIds?.length && isCurrentTarget(targetBotId, targetGroupId)) {
        // The reaction is saved; a failed refresh is caught up by live events.
        await refresh().catch(() => {});
      }
      return true;
    } catch (err) {
      if (!isCurrentTarget(targetBotId, targetGroupId)) return false;
      Alert.alert(t("Could not update reaction"), errorText(err, t("Try again.")));
      return false;
    }
  }

  return {
    composerRef,
    replyTarget,
    setReplyTarget,
    replyQuote,
    setReplyQuote,
    quoteTarget,
    setQuoteTarget,
    sending,
    send,
    retry,
    stop,
    answer,
    react,
    runSlashAction,
  };
}
