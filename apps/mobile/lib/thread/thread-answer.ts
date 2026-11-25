import type { LoginFieldInput, RpcInput } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import type { MobileMessage } from "../api/mobile-types";
import { hapticSuccess } from "../native/haptics";

export type ThreadAnswerContext = {
  botId: string | undefined;
  groupId: string | undefined;
  readOnly: boolean;
  rpc: (proc: "threads/answer", body: RpcInput<"threads/answer">) => Promise<unknown>;
  isCurrentTarget: (botId: string | undefined, groupId: string | undefined) => boolean;
  isFocused: () => boolean;
  refresh: () => Promise<unknown>;
  markRead: () => void;
};

/** Sends an ask answer or dismissal; resolves once the server accepts it. */
export async function answerThreadMessage(
  {
    botId,
    groupId,
    readOnly,
    rpc,
    isCurrentTarget,
    isFocused,
    refresh,
    markRead,
  }: ThreadAnswerContext,
  message: Pick<MobileMessage, "id" | "runId">,
  answer: string,
  fields?: readonly LoginFieldInput[],
  dismiss?: boolean,
  remember?: false,
) {
  if (readOnly || (!botId && !groupId) || !message.runId) return;
  markRead();
  await rpc("threads/answer", {
    ...(groupId ? { groupId } : { botId }),
    runId: message.runId,
    messageId: message.id,
    answer,
    ...(fields ? { fields: [...fields] } : {}),
    ...(remember === false ? { remember } : {}),
    ...(dismiss ? { dismiss: true as const } : {}),
  });
  // The answer is saved once the server accepts it; a failed refresh only delays the card.
  if (isCurrentTarget(botId, groupId)) {
    if (isFocused()) hapticSuccess();
    await refresh().catch(() => undefined);
  }
}

export type ThreadTypeAnswerContext = {
  botId: string | undefined;
  groupId: string | undefined;
  readOnly: boolean;
  rpc: (
    proc: "threads/answerQuestion",
    body: RpcInput<"threads/answerQuestion">,
  ) => Promise<unknown>;
  isCurrentTarget: (botId: string | undefined, groupId: string | undefined) => boolean;
  isFocused: () => boolean;
  refresh: () => Promise<unknown>;
  markRead: () => void;
  clientNonce?: () => string;
};

/** Sends a card's typed answer to that card only; an older server refuses it instead of reading it as a message. */
export async function typeAnswerThreadMessage(
  {
    botId,
    groupId,
    readOnly,
    rpc,
    isCurrentTarget,
    isFocused,
    refresh,
    markRead,
    clientNonce: defaultClientNonce = newClientId,
  }: ThreadTypeAnswerContext,
  message: Pick<MobileMessage, "id">,
  answer: string,
  clientNonce?: string,
) {
  if (readOnly || (!botId && !groupId)) return;
  markRead();
  await rpc("threads/answerQuestion", {
    ...(groupId ? { groupId } : { botId }),
    text: answer,
    replyToMessageId: message.id,
    clientNonce: clientNonce ?? defaultClientNonce(),
  });
  // The answer is saved once the server accepts it; a failed refresh only delays the card.
  if (isCurrentTarget(botId, groupId)) {
    if (isFocused()) hapticSuccess();
    await bestEffort("refresh thread after typed card answer", refresh());
  }
}
