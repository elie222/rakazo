import type { RealtimeCallState } from "@rakazo/contracts";
import { chosenRealtimeModel } from "@rakazo/contracts";
import type { CallExchange } from "@rakazo/core";
import { deadlineSignal } from "@rakazo/core";
import { reportClientError } from "../platform/monitoring.js";
import { rpc, selectedSpaceId, withSpaceHeaders } from "../query/rpc.js";

const endpoint = "/api/voice/realtime";
export const SIGNED_IN_USER_KEY = "rakazo.signedInUser";
/** Earlier releases kept the model choice on the device; it moves to the account once. */
const legacyModelKey = (userId: string) => `rakazo.realtimeCallModel.${userId}`;

/** How long a call waits for the settings before it starts the standard call. */
const SETTINGS_DEADLINE_MS = 5_000;

/**
 * The account's realtime settings, after moving a device-only model choice onto the account
 * when the account has none yet and a connected provider still offers it. The device value
 * is dropped only once nothing is left to move, so a failed save tries again next time.
 */
export async function loadRealtimeCallState(signal?: AbortSignal): Promise<RealtimeCallState> {
  const state = await rpc.voice.realtime.get(undefined, { signal });
  const userId = localStorage.getItem(SIGNED_IN_USER_KEY);
  const legacy = userId ? localStorage.getItem(legacyModelKey(userId)) : null;
  if (!userId || legacy === null) return state;
  const provider = state.providers.find((entry) =>
    entry.models.some((model) => model.id === legacy),
  );
  const moved =
    state.settings.model || !provider
      ? state
      : await rpc.voice.realtime.set(
          { ...state.settings, provider: provider.provider, model: legacy },
          { signal },
        );
  localStorage.removeItem(legacyModelKey(userId));
  return moved;
}

export function openRealtimeCall(input: {
  callId: string;
  botId: string;
  onReady(): void;
  /** No realtime model is chosen or offered; the caller starts the standard call instead. */
  onUnavailable(): void;
  onPhase(phase: "listening" | "thinking" | "speaking"): void;
  onTranscript(exchange: CallExchange): void;
  onFailure(): void;
}) {
  const controller = new AbortController();
  const spaceId = selectedSpaceId();
  const peer = new RTCPeerConnection();
  const channel = peer.createDataChannel("oai-events");
  const audio = new Audio();
  let stream: MediaStream | undefined;
  let offered = false;
  let muted = false;

  function close() {
    if (controller.signal.aborted) return false;
    controller.abort();
    peer.close();
    audio.pause();
    audio.srcObject = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    return true;
  }

  const stop = async () => {
    if (!close() || !offered) return;
    await fetch(`${endpoint}/close`, {
      method: "POST",
      headers: withSpaceHeaders({ "x-rakazo-call-id": input.callId }, spaceId),
      keepalive: true,
    });
  };

  function fail() {
    if (controller.signal.aborted) return;
    void stop().catch((error) => reportClientError(error, "rpc.transport"));
    input.onFailure();
  }

  peer.addEventListener("track", (event) => {
    if (controller.signal.aborted) return;
    audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    void audio.play().catch(fail);
  });
  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "failed" || peer.connectionState === "closed") fail();
  });
  channel.addEventListener("open", () => {
    if (!controller.signal.aborted) input.onReady();
  });
  channel.addEventListener("close", fail);
  const seen = new Set<string>();
  channel.addEventListener("message", (message) => {
    if (controller.signal.aborted || typeof message.data !== "string") return;
    let event: { type?: string; item_id?: string; transcript?: string };
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    switch (event.type) {
      case "input_audio_buffer.speech_started":
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        input.onPhase("listening");
        break;
      case "input_audio_buffer.speech_stopped":
        input.onPhase("thinking");
        break;
      case "output_audio_buffer.started":
        input.onPhase("speaking");
        break;
      case "conversation.item.input_audio_transcription.completed":
      case "response.output_audio_transcript.done":
        if (
          typeof event.item_id === "string" &&
          typeof event.transcript === "string" &&
          event.transcript.trim() &&
          !seen.has(event.item_id)
        ) {
          seen.add(event.item_id);
          input.onTranscript({
            role: event.type === "response.output_audio_transcript.done" ? "bot" : "user",
            text: event.transcript,
          });
        }
        break;
    }
  });

  void (async () => {
    // Without readable settings the standard call is the safe default, not an error toast.
    const state = await loadRealtimeCallState(
      deadlineSignal(SETTINGS_DEADLINE_MS, controller.signal),
    ).catch((error: unknown) => {
      reportClientError(error, "rpc.transport");
      return null;
    });
    if (!state || !chosenRealtimeModel(state)) {
      if (close()) input.onUnavailable();
      return;
    }
    if (controller.signal.aborted) return;
    // "Off" means no noise reduction at all, so the browser's own filter stops too.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: state.settings.noiseReduction !== "off",
      },
    });
    if (controller.signal.aborted) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    for (const track of stream.getAudioTracks()) {
      track.enabled = !muted;
      peer.addTrack(track, stream);
    }
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    offered = true;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: withSpaceHeaders({ "Content-Type": "application/json" }, spaceId),
      body: JSON.stringify({
        callId: input.callId,
        botId: input.botId,
        offer: offer.sdp,
      }),
      signal: deadlineSignal(20_000, controller.signal),
    });
    // Realtime was switched off after the settings were read: the standard call takes over.
    if (response.status === 409) {
      if (close()) input.onUnavailable();
      return;
    }
    if (!response.ok) throw new Error("Realtime call could not connect");
    await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
  })().catch(fail);

  return {
    stop,
    mute(value: boolean) {
      muted = value;
      for (const track of stream?.getAudioTracks() ?? []) track.enabled = !value;
    },
  };
}
