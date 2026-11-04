import type {
  AdapterContext,
  VoiceConversation,
  VoiceConversationRequest,
} from "@rakazo/adapter-kit";
import type { VoiceConversationEvent } from "@rakazo/contracts";
import { VoiceConversationEventSchema } from "@rakazo/contracts";
import { OpenAIVoiceProvider } from "./openai-voice.js";
import { readVoiceJson } from "./voice-http.js";

const FAILURE = "The voice connection failed. Please reconnect.";
const VOICES = [{ id: "marin", label: "Marin", description: "Natural conversation" }];

function greetingInstruction(opening: string): string {
  return `Greet the caller now in the language of this opening, then pause and listen: ${opening}`;
}

export function liveVoiceConfiguration(input: {
  voiceId: string;
  instructions: string;
  opening?: string;
}) {
  if (!VOICES.some((voice) => voice.id === input.voiceId))
    throw new Error("Choose a conversational voice in Voice settings.");
  return {
    model: "gpt-live-1",
    store: false,
    instructions: input.instructions,
    ...(input.opening
      ? {
          input: [
            {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: greetingInstruction(input.opening) }],
            },
          ],
        }
      : {}),
    delegation: { type: "client" },
    audio: { output: { voice: input.voiceId } },
  };
}

export function decodeLiveVoiceEvent(input: unknown): VoiceConversationEvent | null {
  if (!input || typeof input !== "object") return null;
  const e = input as Record<string, unknown>;
  let candidate: unknown;
  switch (e.type) {
    case "session.started":
      candidate = { type: "ready" };
      break;
    case "session.closed":
      candidate = { type: "closed" };
      break;
    case "error":
      candidate = { type: "error", message: FAILURE };
      break;
    case "session.delegation.created": {
      const d = e.delegation as Record<string, unknown> | undefined;
      if (d?.target !== "client") return null;
      candidate = { type: "delegation", id: d.id };
      break;
    }
    case "session.input_transcript.delta":
    case "session.output_transcript.delta":
      candidate = {
        type: "transcript",
        id: e.event_id,
        role: e.type === "session.input_transcript.delta" ? "user" : "bot",
        text: e.delta,
        startMs: e.start_ms,
        endMs: e.end_ms,
      };
      break;
    default:
      return null;
  }
  const parsed = VoiceConversationEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function commentaryChunks(content: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of content) {
    if (new TextEncoder().encode(chunk + character).length > 450) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export class OpenAILiveVoiceProvider extends OpenAIVoiceProvider {
  override describe() {
    return {
      ...super.describe(),
      id: "openai-live",
      capabilities: { catalog: true, synthesize: true, transcribe: true, conversational: true },
    };
  }
  override async listVoices() {
    return VOICES;
  }

  async converse(
    request: VoiceConversationRequest,
    context: AdapterContext,
  ): Promise<VoiceConversation> {
    const { default: WebSocket } = await import("ws");
    const response = await fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${request.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: liveVoiceConfiguration(request),
        transport: { type: "webrtc", sdp: request.offerSdp },
      }),
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? "Reconnect your voice provider in Voice settings."
          : "Could not start the voice session. Check provider access and credit.",
      );
    const result = (await readVoiceJson(response, { requireValid: true })) as {
      session?: { id?: unknown };
      transport?: { sdp?: unknown };
    };
    if (
      typeof result.session?.id !== "string" ||
      typeof result.transport?.sdp !== "string" ||
      result.transport.sdp.length > 65536
    )
      throw new Error(FAILURE);
    const socket = new WebSocket(
      `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(result.session.id)}/attach`,
      {
        headers: { Authorization: `Bearer ${request.apiKey}` },
        handshakeTimeout: 10_000,
        maxPayload: 1024 * 1024,
      },
    );
    const queue: VoiceConversationEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let closePromise: Promise<void> | undefined;
    let final: (() => void) | undefined;
    const finalized = new Promise<void>((resolve) => {
      final = resolve;
    });
    const push = (event: VoiceConversationEvent) => {
      if (done) return;
      if (queue.length >= 512) {
        socket.terminate();
        return;
      }
      queue.push(event);
      wake?.();
      wake = undefined;
    };
    socket.on("message", (raw) => {
      let event: VoiceConversationEvent | null;
      try {
        event = decodeLiveVoiceEvent(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (!event) return;
      push(event);
      if (event.type === "closed") {
        final?.();
        done = true;
        wake?.();
      }
    });
    socket.on("error", () => push({ type: "error", message: FAILURE }));
    socket.on("close", () => {
      if (!done) push({ type: "error", message: FAILURE });
      done = true;
      final?.();
      wake?.();
    });
    const close = () =>
      (closePromise ??= (async () => {
        clearInterval(heartbeat);
        clearTimeout(limit);
        context.signal.removeEventListener("abort", aborted);
        if (socket.readyState === WebSocket.OPEN && !done) {
          socket.send(JSON.stringify({ type: "session.close" }));
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            finalized,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 2000);
            }),
          ]);
          clearTimeout(timer);
        }
        push({ type: "closed" });
        done = true;
        socket.terminate();
        wake?.();
      })());
    const aborted = () => {
      void close();
    };
    const heartbeat = setInterval(() => push({ type: "heartbeat" }), 10_000);
    const limit = setTimeout(() => {
      push({
        type: "error",
        message: "The call reached its 30-minute limit. Start another call to continue.",
      });
      void close();
    }, 30 * 60_000);
    context.signal.addEventListener("abort", aborted, { once: true });
    try {
      if (context.signal.aborted) throw new Error("Call cancelled.");
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", () => reject(new Error(FAILURE)));
        socket.once("close", () => reject(new Error(FAILURE)));
      });
      if (context.signal.aborted) {
        await close();
        throw new Error("Call cancelled.");
      }
      if (request.opening) {
        for (const [index, content] of commentaryChunks(
          greetingInstruction(request.opening),
        ).entries())
          socket.send(
            JSON.stringify({
              type: "session.commentary.append",
              event_id: `greeting_${index}`,
              delegation_id: null,
              content,
            }),
          );
      }
    } catch (error) {
      await close();
      throw error;
    }
    return {
      answerSdp: result.transport.sdp,
      events: (async function* () {
        try {
          while (!done || queue.length) {
            const event = queue.shift();
            if (event) yield event;
            else
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
          }
        } finally {
          await close();
        }
      })(),
      respond(delegationId, content) {
        if (done || closePromise || socket.readyState !== WebSocket.OPEN) return;
        // UTF-8 bytes conservatively bound tokens without cutting words from the result.
        for (const part of commentaryChunks(content))
          socket.send(
            JSON.stringify({
              type: "session.commentary.append",
              delegation_id: delegationId,
              content: part,
            }),
          );
      },
      close,
    };
  }
}
