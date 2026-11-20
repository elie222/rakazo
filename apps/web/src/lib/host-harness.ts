import { t } from "@lingui/core/macro";
import type { ThreadMessage } from "@rakazo/contracts";
import { desktopBridge } from "./platform/desktop";

/** Resolve the device's choice on each send; a failed local send never falls through to a server run. */
export async function selectedHostSend(input: {
  botId?: string;
  groupId?: string;
  spaceId?: string;
  textOnly: boolean;
}) {
  const bridge = desktopBridge()?.harness;
  if (!bridge || !input.botId || input.groupId) return null;
  if (!input.spaceId) throw new Error("Local agent unavailable");
  const scope = { botId: input.botId, spaceId: input.spaceId };
  if (!(await bridge.selection(scope))) return null;
  if (!input.textOnly)
    throw new Error(
      t`Local agents accept text messages. Send attachments, replies and routines with a server agent.`,
    );
  return (text: string, clientNonce: string) => bridge.send({ ...scope, text, clientNonce });
}

export async function answerHostHarness(message: ThreadMessage, answer: string) {
  return message.runId &&
    message.blocks.some((block) => block.kind === "ask" && block.nativeRequestId)
    ? ((await desktopBridge()?.harness?.answer({
        runId: message.runId,
        messageId: message.id,
        answer,
      })) ?? false)
    : false;
}

export async function stopHostHarness(input: { botId: string; spaceId?: string }) {
  if (input.spaceId)
    await desktopBridge()?.harness?.stop({ botId: input.botId, spaceId: input.spaceId });
}
