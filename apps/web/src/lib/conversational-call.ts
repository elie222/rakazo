import type { VoiceConversationEvent } from "@rakazo/contracts";
import { createVoiceMedia, ensureAiDataConsent } from "@rakazo/core";
import { createSpaceRpc, selectedSpaceId } from "./rpc.js";

export function conversationalCall(
  input: { botId: string; callId: string },
  event: (event: VoiceConversationEvent) => void,
  error: (error: unknown) => void,
) {
  const rpc = createSpaceRpc(selectedSpaceId());
  return createVoiceMedia({
    microphone: async () => {
      await ensureAiDataConsent({
        uses: ["voice", "model", "memory"],
        status: () =>
          rpc.aiConsent.status({ botId: input.botId, uses: ["voice", "model", "memory"] }),
        allow: (value) => rpc.aiConsent.allow(value),
        prompt: async (recipient) =>
          window.confirm(`Allow ${recipient.name} to process this conversation?`),
      });
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    },
    peer: (stream, fail) => {
      const pc = new RTCPeerConnection();
      const audio = new Audio();
      audio.autoplay = true;
      pc.ontrack = (received) => {
        audio.srcObject = received.streams[0] ?? new MediaStream([received.track]);
        void audio
          .play()
          .catch(() => fail(new Error("Audio playback was blocked. Start the call again.")));
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") event({ type: "ready" });
        if (["failed", "disconnected"].includes(pc.connectionState))
          fail(new Error("The voice connection was lost. Please reconnect."));
      };
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      const channel = pc.createDataChannel("voice-events");
      return {
        async offer() {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          if (!offer.sdp) throw new Error("Could not prepare microphone audio.");
          return offer.sdp;
        },
        async answer(sdp) {
          await pc.setRemoteDescription({ type: "answer", sdp });
        },
        close() {
          pc.ontrack = null;
          pc.onconnectionstatechange = null;
          channel.close();
          pc.close();
          audio.pause();
          audio.srcObject = null;
        },
      };
    },
    connect: async function* (offerSdp, signal) {
      const events = await rpc.threads.converse({ ...input, offerSdp }, { signal });
      yield* events;
    },
    event,
    error,
  });
}
