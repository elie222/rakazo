import type { RealtimeVoiceConnection, RealtimeVoiceEvent } from "@rakazo/adapters";
import { knownVoiceProvider } from "@rakazo/adapters";
import type { Actor, SettingsScope } from "@rakazo/contracts";
import { anySignal, deadlineSignal } from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  runAsTenant,
  storedMessageBlocks,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { assertTeachingSendAllowed } from "../bots/taught-skills.js";
import { readBoundedBody } from "../http/http-body.js";
import { resolveThreadTarget, sendThreadMessage, threadHead } from "../threads/thread-target.js";
import type { VoiceDeps } from "./voice.js";
import { loadDefaultVoiceCredential } from "./voice.js";

const offerBody = z.object({
  botId: z.string().min(1).max(100),
  model: z.string().min(1).max(100),
  offer: z
    .string()
    .startsWith("v=0")
    .max(64 * 1024),
  callId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
});
type RealtimeDeps = VoiceDeps & Parameters<typeof sendThreadMessage>[0];

function messageText(message: Parameters<typeof storedMessageBlocks>[0]) {
  return storedMessageBlocks(message)
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("\n")
    .slice(0, 1500);
}

async function activeVoice(
  deps: VoiceDeps,
  actor: Actor,
  signal?: AbortSignal,
  scope?: SettingsScope,
) {
  const loaded = await loadDefaultVoiceCredential(deps, actor, scope, signal);
  if (!loaded || loaded.deployment) return null;
  const realtime = knownVoiceProvider(loaded.cred.provider)?.realtime;
  return realtime ? { loaded, realtime } : null;
}

export function mountRealtimeVoiceRoutes(
  app: Hono,
  deps: RealtimeDeps,
  authenticate: (c: Context, recheck?: boolean) => Promise<Actor | null>,
  trustedOrigin: (origin: string) => boolean,
  enabled: boolean,
  shutdown: AbortSignal,
) {
  const active = new Map<string, { callId: string; stop(): Promise<void> }>();
  shutdown.addEventListener(
    "abort",
    () => {
      for (const call of active.values()) void call.stop();
    },
    { once: true },
  );
  if (!enabled) return;

  app.get("/api/voice/realtime/models", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const voice = await runAsTenant(actor, () =>
      activeVoice(deps, actor, c.req.raw.signal, "account"),
    );
    return c.json({ models: voice?.realtime.models ?? [] }, 200, { "Cache-Control": "no-store" });
  });

  app.post("/api/voice/realtime/close", async (c) => {
    if (!trustedOrigin(c.req.header("origin") ?? "")) return c.json({ error: "Forbidden" }, 403);
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const call = active.get(actor.userId);
    if (call && call.callId === c.req.header("x-rakazo-call-id")) await call.stop();
    return c.body(null, 204);
  });

  app.post("/api/voice/realtime", async (c) => {
    if (!trustedOrigin(c.req.header("origin") ?? "")) return c.json({ error: "Forbidden" }, 403);
    const sessionActor = await authenticate(c);
    if (!sessionActor) return c.json({ error: "Unauthorized" }, 401);
    const actor = sessionActor;
    const raw = await readBoundedBody(c.req.raw, 70 * 1024);
    if (raw === null) return c.json({ error: "Request too large" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const input = offerBody.safeParse(body);
    if (!input.success) return c.json({ error: "Invalid call offer" }, 400);
    const { callId, botId, offer, model } = input.data;
    if (active.has(actor.userId)) return c.json({ error: "Another realtime call is active" }, 409);
    const controller = new AbortController();
    const signal = deadlineSignal(30 * 60_000, anySignal([controller.signal, shutdown]));
    let connection: RealtimeVoiceConnection | undefined;
    let writing = Promise.resolve();
    let stopped = false;
    const call = {
      callId,
      async stop() {
        if (!stopped) {
          stopped = true;
          controller.abort();
          connection?.close();
          if (active.get(actor.userId) === call) active.delete(actor.userId);
        }
        await writing;
      },
    };
    active.set(actor.userId, call);
    signal.addEventListener("abort", call.stop, { once: true });
    try {
      const setupSignal = deadlineSignal(15_000, anySignal([signal, c.req.raw.signal]));
      const { target, voice, history } = await runAsTenant(actor, async () => {
        const target = await resolveThreadTarget(deps.prisma, actor, { botId });
        if (target.kind !== "bot") throw new Error("Expected a bot thread");
        await assertTeachingSendAllowed(deps.prisma, actor.spaceId, botId);
        const [voice, history] = await Promise.all([
          activeVoice(deps, actor, setupSignal),
          deps.prisma.message.findMany({
            where: { threadId: target.threadId, role: { in: ["user", "bot"] } },
            orderBy: { seq: "desc" },
            take: 12,
          }),
        ]);
        return { target, voice, history };
      });
      if (!voice?.realtime.models.some((entry) => entry.id === model)) {
        call.stop();
        return c.json({ error: "Realtime model unavailable on the selected connection" }, 400);
      }
      connection = await voice.realtime.connect({
        offer,
        model,
        apiKey: voice.loaded.apiKey,
        voiceId: target.bot.voiceId || voice.loaded.cred.voiceId,
        instructions: [
          `You speak as ${target.bot.name} in their Rakazo chat. Keep spoken answers brief. For memory, skills, tools, older history, or work, use ask_bot. Give a brief acknowledgement when it helps, and never invent a tool result.`,
          target.bot.instructions.slice(0, 6000),
          "Recent chat messages for context only:",
          JSON.stringify(
            history
              .reverse()
              .map((message) => ({ role: message.role, text: messageText(message) })),
          ),
        ].join("\n\n"),
        signal: setupSignal,
      });
      if (signal.aborted) {
        connection.close();
        signal.throwIfAborted();
      }

      const peer = connection;
      let turn: { itemId: string; text?: string; taskIds: string[] } | undefined;
      const responseTurns = new Map<string, string>();
      const delegated = new Set<string>();
      const recorded = new Set<string>();
      const idValid = (id: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(id);

      async function currentTarget() {
        const current = await authenticate(c, true);
        if (current?.userId !== actor.userId || current.spaceId !== actor.spaceId) {
          void call.stop();
          throw new Error("Call session is no longer authorized");
        }
        const fresh = await resolveThreadTarget(deps.prisma, actor, { botId });
        if (fresh.kind !== "bot" || fresh.threadId !== target.threadId)
          throw new Error("Call thread changed");
        await assertTeachingSendAllowed(deps.prisma, actor.spaceId, botId);
        return fresh;
      }
      async function store(event: Extract<RealtimeVoiceEvent, { kind: "transcript" }>) {
        if (!idValid(event.itemId) || recorded.has(event.itemId)) return;
        const text = event.text.trim().slice(0, 4000);
        if (!text) return;
        const fresh = await currentTarget();
        const blocks = [{ kind: "text" as const, text }];
        const saved = await deps.prisma.$transaction(async (tx) => {
          const message = await createThreadMessageInTransaction(tx, {
            threadId: fresh.threadId,
            role: event.role,
            ...(event.role === "bot" ? { botId } : { authorUserId: actor.userId }),
            clientNonce: `call:${callId}:${event.itemId}`,
            blocks,
          });
          return appendEventInTransaction(tx, {
            spaceId: actor.spaceId,
            botId,
            threadId: fresh.threadId,
            type: "thread.message.created",
            payload: { messageId: message.id, role: event.role, blocks, callId },
          });
        });
        recorded.add(event.itemId);
        await deps.events.notify(fresh.threadId, saved.seq);
        if (event.role === "user" && turn?.itemId === event.itemId) turn.text = text;
      }

      async function delegate(toolId: string, utterance: { itemId: string; text: string }) {
        if (delegated.has(utterance.itemId)) {
          peer.taskResult(toolId, "This request is already being handled in the chat.");
          return;
        }
        delegated.add(utterance.itemId);
        const nonce = `realtime-task:${callId}:${utterance.itemId}`;
        const cursor = await runAsTenant(actor, async () => {
          const fresh = await currentTarget();
          const head = await threadHead(deps.prisma, fresh);
          await sendThreadMessage(deps, actor, fresh, {
            text: utterance.text,
            clientNonce: nonce,
          });
          return head.cursor;
        });
        if (signal.aborted) return;
        peer.taskResult(
          toolId,
          "The bot is working on this in the Rakazo chat. Acknowledge briefly and continue the conversation.",
        );
        await runAsTenant(actor, async () => {
          for await (const event of deps.events.follow(target.threadId, cursor, signal)) {
            if (
              !event.runId ||
              (event.type !== "run.completed" &&
                event.type !== "run.failed" &&
                event.type !== "run.cancelled" &&
                event.type !== "run.waiting_input")
            )
              continue;
            const update = await runAsTenant(actor, async () => {
              await currentTarget();
              const run = await deps.prisma.run.findFirst({
                where: {
                  id: event.runId,
                  userId: actor.userId,
                  threadId: target.threadId,
                  sourceMessage: { clientNonce: nonce },
                },
                select: { id: true, status: true },
              });
              if (!run) return;
              if (run.status === "waiting_input") {
                return {
                  finished: false,
                  text: "The bot needs your input or approval in the Rakazo chat.",
                };
              }
              if (run.status === "failed" || run.status === "cancelled") {
                return {
                  finished: true,
                  text: "The bot could not finish the request. See the chat.",
                };
              }
              if (run.status !== "completed") return;
              const latest = await deps.prisma.message.findFirst({
                where: { runId: run.id, threadId: target.threadId, role: "bot" },
                orderBy: { seq: "desc" },
              });
              return {
                finished: true,
                text: latest
                  ? messageText(latest) || "The bot finished the task. See the chat."
                  : "The bot finished the task. See the chat.",
              };
            });
            if (update && !signal.aborted) peer.taskUpdate(update.text);
            if (update?.finished || signal.aborted) break;
          }
        });
      }

      peer.onClose(call.stop);
      peer.onEvent((event) => {
        if (signal.aborted) return;
        writing = writing
          .then(async () => {
            if (event.kind === "turn" && idValid(event.itemId)) {
              for (const taskId of turn?.taskIds ?? [])
                peer.taskResult(taskId, "The previous voice turn ended.");
              turn = { itemId: event.itemId, taskIds: [] };
            }
            if (event.kind === "responseStart" && turn && idValid(event.responseId)) {
              responseTurns.set(event.responseId, turn.itemId);
            }
            if (event.kind === "responseDone") {
              const itemId = responseTurns.get(event.responseId);
              responseTurns.delete(event.responseId);
              for (const taskId of event.taskIds.filter(idValid)) {
                if (turn && turn.itemId === itemId) turn.taskIds.push(taskId);
                else peer.taskResult(taskId, "The previous voice turn ended.");
              }
            }
            if (event.kind === "transcript") await runAsTenant(actor, () => store(event));
            if (turn?.text) {
              const utterance = { itemId: turn.itemId, text: turn.text };
              for (const toolId of turn.taskIds.splice(0)) {
                void bestEffort(
                  "realtime voice task",
                  (async () => {
                    try {
                      await delegate(toolId, utterance);
                    } catch (error) {
                      if (signal.aborted) return;
                      peer.taskResult(toolId, "The bot could not start this request.");
                      throw error;
                    }
                  })(),
                );
              }
            }
          })
          .catch(() => {
            void call.stop();
          });
      });
      return c.text(peer.answer, 200, {
        "Content-Type": "application/sdp",
        "Cache-Control": "no-store",
      });
    } catch {
      call.stop();
      return c.json({ error: "Could not open a realtime call" }, 502);
    }
  });
}
