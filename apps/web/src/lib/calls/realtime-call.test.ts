import { afterEach, expect, it, vi } from "vitest";
import { openRealtimeCall } from "./realtime-call.js";

vi.mock("../platform/monitoring.js", () => ({ reportClientError: vi.fn() }));
vi.mock("../query/rpc.js", () => ({
  selectedSpaceId: () => "space1",
  withSpaceHeaders: (headers: HeadersInit) => headers,
}));

afterEach(() => vi.unstubAllGlobals());

it("streams the selected call to the microphone and tears down both ends", async () => {
  const microphone = { enabled: true, stop: vi.fn() };
  const stream = { getTracks: () => [microphone], getAudioTracks: () => [microphone] };
  const channel = new EventTarget();
  class Peer extends EventTarget {
    createDataChannel = vi.fn(() => channel);
    addTrack = vi.fn();
    close = vi.fn();
    createOffer = vi.fn(async () => ({ sdp: "v=0 test offer" }));
    setLocalDescription = vi.fn();
    setRemoteDescription = vi.fn();
  }
  class Player {
    srcObject = null;
    play = vi.fn(async () => {});
    pause = vi.fn();
  }
  const peers: Peer[] = [];
  const audio = new Player();
  const fetch = vi.fn(async () => new Response("v=0 test answer"));
  vi.stubGlobal(
    "RTCPeerConnection",
    class extends Peer {
      constructor() {
        super();
        peers.push(this);
      }
    },
  );
  vi.stubGlobal(
    "Audio",
    class {
      srcObject = null;
      play = audio.play;
      pause = audio.pause;
    },
  );
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
  vi.stubGlobal("fetch", fetch);
  const onTranscript = vi.fn();
  const onReady = vi.fn();
  const call = openRealtimeCall({
    callId: "test-call",
    botId: "test-bot",
    model: "voice-model",
    onTranscript,
    onReady,
    onPhase: vi.fn(),
    onFailure: vi.fn(),
  });

  const [peer] = peers;
  if (!peer) throw new Error("Expected an active peer");
  await vi.waitFor(() =>
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "v=0 test answer",
    }),
  );
  expect(peer.addTrack).toHaveBeenCalledWith(microphone, stream);
  expect(fetch).toHaveBeenCalledWith(
    "/api/voice/realtime",
    expect.objectContaining({
      body: JSON.stringify({
        callId: "test-call",
        botId: "test-bot",
        model: "voice-model",
        offer: "v=0 test offer",
      }),
    }),
  );
  const trackEvent = Object.assign(new Event("track"), { streams: [stream] });
  peer.dispatchEvent(trackEvent);
  expect(audio.play).toHaveBeenCalledOnce();
  channel.dispatchEvent(new Event("open"));
  expect(onReady).toHaveBeenCalledOnce();
  const event = new MessageEvent("message", {
    data: JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "spoken",
      transcript: "Hallo.",
    }),
  });
  channel.dispatchEvent(event);
  channel.dispatchEvent(event);
  expect(onTranscript).toHaveBeenCalledExactlyOnceWith({ role: "user", text: "Hallo." });
  call.mute(true);
  expect(microphone.enabled).toBe(false);
  await call.stop();
  expect(microphone.stop).toHaveBeenCalledOnce();
  expect(peer.close).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(
    "/api/voice/realtime/close",
    expect.objectContaining({
      headers: { "x-rakazo-call-id": "test-call" },
    }),
  );
});
