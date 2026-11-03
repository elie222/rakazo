import type { LoginFieldInput, RpcInput } from "@rakazo/contracts";
import type { MobileMessage } from "./api";

export type ThreadAnswerContext = {
  botId: string | undefined;
  groupId: string | undefined;
  readOnly: boolean;
  rpc: (proc: "threads/answer", body: RpcInput<"threads/answer">) => Promise<unknown>;
  isCurrentTarget: (botId: string | undefined, groupId: string | undefined) => boolean;
  refresh: () => Promise<unknown>;
  markRead: () => void;
};

/** Sends an ask answer or dismissal; resolves once the server accepts it. */
export async function answerThreadMessage(
  { botId, groupId, readOnly, rpc, isCurrentTarget, refresh, markRead }: ThreadAnswerContext,
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
  if (isCurrentTarget(botId, groupId)) await refresh().catch(() => undefined);
}
