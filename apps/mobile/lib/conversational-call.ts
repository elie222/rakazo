import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { AppContract, VoiceConversationEvent } from "@rakazo/contracts";
import { createVoiceMedia, ensureAiDataConsent } from "@rakazo/core";
import { fetch as streamingFetch } from "expo/fetch";
import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";
import type { MediaStream } from "react-native-webrtc";
import { promptAiConsent } from "./ai-consent";
import type { ApiRequestContext } from "./api";
import { captureApiRequestContext, currentApiBase, rpc } from "./api";
import { fetchServer } from "./server-headers";
import { currentSessionGeneration } from "./session";

export async function conversationalCall(
  input: { botId: string; callId: string },
  event: (event: VoiceConversationEvent) => void,
  error: (error: unknown) => void,
  suppliedContext?: ApiRequestContext,
) {
  const context = suppliedContext ?? (await captureApiRequestContext());
  const current = () =>
    context.sessionGeneration === currentSessionGeneration() &&
    context.apiBase === currentApiBase();
  const native = await import("react-native-webrtc");
  const audioRoute =
    Platform.OS === "android"
      ? requireOptionalNativeModule<{
          startCallAudio(id: string): Promise<void>;
          setCallSpeaker(id: string, enabled: boolean): Promise<void>;
          stopCallAudio(id: string): Promise<void>;
        }>("RakazoNotifications")
      : null;
  let routing: Promise<void> | undefined;
  const client: ContractRouterClient<AppContract> = createORPCClient(
    new RPCLink({
      url: `${context.apiBase}/rpc`,
      fetch: (request, init, options) => {
        if (!current()) throw new Error("The account changed. Start a new call.");
        const headers = new Headers(request instanceof Request ? request.headers : undefined);
        for (const [name, value] of Object.entries(context.headers)) headers.set(name, value);
        headers.set("origin", "rakazo://");
        return fetchServer(
          request,
          { ...init, headers, signal: options.signal },
          context.apiBase,
          streamingFetch as typeof fetch,
        );
      },
    }),
  );
  const media = createVoiceMedia<MediaStream>({
    microphone: async () => {
      await ensureAiDataConsent({
        uses: ["voice", "model", "memory"],
        status: () =>
          rpc(
            "aiConsent/status",
            { botId: input.botId, uses: ["voice", "model", "memory"] },
            { requestContext: context },
          ),
        allow: (value) => rpc("aiConsent/allow", value, { requestContext: context }),
        prompt: promptAiConsent,
      });
      if (!current()) throw new Error("The account changed. Start a new call.");
      return native.mediaDevices.getUserMedia({ audio: true, video: false });
    },
    peer: (stream, fail) => {
      const pc = new native.RTCPeerConnection({});
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "connected") event({ type: "ready" });
        if (["failed", "disconnected"].includes(pc.connectionState))
          fail(new Error("The voice connection was lost. Please reconnect."));
      });
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      const channel = pc.createDataChannel("voice-events");
      return {
        async offer() {
          if (Platform.OS === "android") {
            if (!audioRoute?.startCallAudio)
              throw new Error("Install the latest voice preview to enable the call speaker.");
            routing = audioRoute.startCallAudio(input.callId);
            await routing;
          }
          const offer = await pc.createOffer({});
          await pc.setLocalDescription(offer);
          if (!offer.sdp) throw new Error("Could not prepare microphone audio.");
          return offer.sdp;
        },
        async answer(sdp) {
          await pc.setRemoteDescription({ type: "answer", sdp });
        },
        close() {
          channel.close();
          pc.close();
          stream.release();
          // Wait for an in-flight start; an old call must not release a newer call's route.
          void routing?.then(() => audioRoute?.stopCallAudio(input.callId)).catch(error);
        },
      };
    },
    connect: async function* (offerSdp, signal) {
      const events = await client.threads.converse({ ...input, offerSdp }, { signal });
      for await (const value of events) {
        if (!current()) throw new Error("The account changed.");
        yield value;
      }
    },
    event,
    error,
  });
  return {
    ...media,
    hasSpeaker: Platform.OS === "android",
    async setSpeaker(enabled: boolean) {
      if (!audioRoute) throw new Error("Call speaker control is unavailable.");
      await audioRoute.setCallSpeaker(input.callId, enabled);
    },
  };
}
