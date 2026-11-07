import { threadSendInput, threadSendWithRoutinesInput } from "@rakazo/contracts";
import type { createSpaceRpc } from "./rpc";

type Threads = ReturnType<typeof createSpaceRpc>["threads"];
type SendBody = Parameters<Threads["send"]>[0];
type RoutineBody = Parameters<Threads["sendWithRoutines"]>[0];
export type ComposerSendEnvelope =
  | { procedure: "send"; body: SendBody }
  | { procedure: "sendWithRoutines"; body: RoutineBody };
export const COMPOSER_SEND_STORAGE_PREFIX = "rakazo.composerSend.";

export type ComposerSendScope = { server: string; userId: string; spaceId: string | null };
export type ComposerSendContext = {
  reply: string | null;
  quote: string | null;
  page: string | null;
  attachments: string[];
};
type SavedSend = {
  version: 1;
  draftKey: string;
  target: string;
  scope: ComposerSendScope;
  context: ComposerSendContext;
  envelope: ComposerSendEnvelope;
};

/** Browser-local preservation only. Acceptance and replay belong to threads/send. */
export function readComposerSend(key: string, scope: ComposerSendScope): SavedSend | null {
  if (!scope.server || scope.server === "null" || !scope.userId || !scope.spaceId) return null;
  try {
    const saved = JSON.parse(
      localStorage.getItem(`${COMPOSER_SEND_STORAGE_PREFIX}${key}`) ?? "null",
    ) as SavedSend | null;
    if (
      saved?.version !== 1 ||
      saved.draftKey !== key ||
      saved.scope?.server !== scope.server ||
      saved.scope?.userId !== scope.userId ||
      saved.scope?.spaceId !== scope.spaceId
    )
      return null;
    if (
      !saved.context ||
      !Array.isArray(saved.context.attachments) ||
      !saved.context.attachments.every((id) => typeof id === "string") ||
      ![saved.context.reply, saved.context.quote, saved.context.page].every(
        (value) => value === null || typeof value === "string",
      )
    )
      return null;
    const envelope = saved.envelope;
    if (
      !envelope ||
      !["send", "sendWithRoutines"].includes(envelope.procedure) ||
      typeof envelope.body?.clientNonce !== "string"
    )
      return null;
    const schema = envelope.procedure === "send" ? threadSendInput : threadSendWithRoutinesInput;
    if (!schema.safeParse(envelope.body).success) return null;
    const target = envelope.body.groupId
      ? `group:${envelope.body.groupId}`
      : `bot:${envelope.body.botId}`;
    if (saved.target !== target || (envelope.body.botId && target !== key)) return null;
    return saved;
  } catch {
    return null;
  }
}

export function saveComposerSend(
  key: string,
  scope: ComposerSendScope,
  context: ComposerSendContext,
  envelope: ComposerSendEnvelope,
): void {
  if (!scope.server || scope.server === "null" || !scope.userId || !scope.spaceId) return;
  try {
    localStorage.setItem(
      `${COMPOSER_SEND_STORAGE_PREFIX}${key}`,
      JSON.stringify({
        version: 1,
        draftKey: key,
        target: envelope.body.groupId
          ? `group:${envelope.body.groupId}`
          : `bot:${envelope.body.botId}`,
        scope,
        context,
        envelope,
      } satisfies SavedSend),
    );
  } catch {
    // Best effort: storage failure cannot promise recovery after document loss.
  }
}

export function clearComposerSend(key: string, nonce?: string): void {
  try {
    const storageKey = `${COMPOSER_SEND_STORAGE_PREFIX}${key}`;
    if (
      nonce &&
      JSON.parse(localStorage.getItem(storageKey) ?? "null")?.envelope?.body?.clientNonce !== nonce
    )
      return;
    localStorage.removeItem(storageKey);
  } catch {
    /* Draft remains usable without storage. */
  }
}
