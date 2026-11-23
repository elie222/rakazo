import type { RealtimeCallSettings, RealtimeCallState } from "@rakazo/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadRealtimeCallState, openRealtimeCall, SIGNED_IN_USER_KEY } from "./realtime-call.js";

const realtime = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));

vi.mock("../platform/monitoring.js", () => ({ reportClientError: vi.fn() }));
vi.mock("../query/rpc.js", () => ({
  rpc: { voice: { realtime } },
  selectedSpaceId: () => "space1",
  withSpaceHeaders: (headers: HeadersInit) => headers,
}));

function callState(settings: Partial<RealtimeCallSettings> = {}): RealtimeCallState {
  return {
    available: true,
    settings: { provider: "voice-provider", model: "voice-model", ...settings },
    providers: [
      {
        provider: "voice-provider",
        models: [{ id: "voice-model", label: "Voice model", capabilities: [] }],
        voices: ["voice-a"],
      },
    ],
  };
}

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

beforeEach(() => {
  realtime.get.mockReset();
  realtime.set.mockReset();
  vi.stubGlobal("localStorage", storage());
});
afterEach(() => vi.unstubAllGlobals());

function stubMedia() {
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
  const peers: Peer[] = [];
  const audio = { play: vi.fn(async () => {}), pause: vi.fn() };
  const fetch = vi.fn(async () => new Response("v=0 test answer"));
  const getUserMedia = vi.fn(async () => stream);
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
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("fetch", fetch);
  return { microphone, stream, channel, peers, audio, fetch, getUserMedia };
}

function open(callbacks: { onUnavailable?: () => void; onFailure?: () => void } = {}) {
  const onTranscript = vi.fn();
  const onReady = vi.fn();
  const call = openRealtimeCall({
    callId: "test-call",
    botId: "test-bot",
    onTranscript,
    onReady,
    onUnavailable: callbacks.onUnavailable ?? vi.fn(),
    onPhase: vi.fn(),
    onFailure: callbacks.onFailure ?? vi.fn(),
  });
  return { call, onTranscript, onReady };
}

it("streams the selected call to the microphone and tears down both ends", async () => {
  realtime.get.mockResolvedValue(callState());
  const { microphone, stream, channel, peers, audio, fetch } = stubMedia();
  const { call, onTranscript, onReady } = open();

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
      body: JSON.stringify({ callId: "test-call", botId: "test-bot", offer: "v=0 test offer" }),
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

it("hands over to the standard call without the microphone when realtime is off", async () => {
  realtime.get.mockResolvedValue(callState({ model: "" }));
  const { fetch, getUserMedia } = stubMedia();
  const onUnavailable = vi.fn();
  const onFailure = vi.fn();
  open({ onUnavailable, onFailure });
  await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalledOnce());
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(onFailure).not.toHaveBeenCalled();
});

it("treats unreadable settings as the standard call, not as a failed call", async () => {
  realtime.get.mockRejectedValue(new Error("offline"));
  stubMedia();
  const onUnavailable = vi.fn();
  const onFailure = vi.fn();
  open({ onUnavailable, onFailure });
  await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalledOnce());
  expect(onFailure).not.toHaveBeenCalled();
});

it.each([
  [undefined, true],
  ["room", true],
  ["off", false],
] as const)(
  "asks the browser for noise suppression with the %s microphone: %s",
  async (noiseReduction, suppress) => {
    realtime.get.mockResolvedValue(callState({ noiseReduction }));
    const { getUserMedia } = stubMedia();
    open();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: suppress },
    });
  },
);

it("moves a device-only model choice onto the account once", async () => {
  localStorage.setItem(SIGNED_IN_USER_KEY, "user-1");
  localStorage.setItem("rakazo.realtimeCallModel.user-1", "voice-model");
  realtime.get.mockResolvedValue(callState({ provider: "", model: "" }));
  realtime.set.mockImplementation(async (settings: RealtimeCallSettings) => ({
    ...callState(),
    settings,
  }));
  const state = await loadRealtimeCallState();
  expect(realtime.set).toHaveBeenCalledWith(
    { provider: "voice-provider", model: "voice-model" },
    expect.anything(),
  );
  expect(state.settings.model).toBe("voice-model");
  expect(localStorage.getItem("rakazo.realtimeCallModel.user-1")).toBeNull();
  await loadRealtimeCallState();
  expect(realtime.set).toHaveBeenCalledOnce();
});

it("keeps an account choice over a stale device choice and drops models no provider offers", async () => {
  localStorage.setItem(SIGNED_IN_USER_KEY, "user-1");
  localStorage.setItem("rakazo.realtimeCallModel.user-1", "retired-model");
  realtime.get.mockResolvedValue(callState({ provider: "", model: "" }));
  await loadRealtimeCallState();
  localStorage.setItem("rakazo.realtimeCallModel.user-1", "voice-model");
  realtime.get.mockResolvedValue(callState());
  await loadRealtimeCallState();
  expect(realtime.set).not.toHaveBeenCalled();
  expect(localStorage.getItem("rakazo.realtimeCallModel.user-1")).toBeNull();
});

it("keeps the device choice when moving it onto the account fails", async () => {
  localStorage.setItem(SIGNED_IN_USER_KEY, "user-1");
  localStorage.setItem("rakazo.realtimeCallModel.user-1", "voice-model");
  realtime.get.mockResolvedValue(callState({ provider: "", model: "" }));
  realtime.set.mockRejectedValueOnce(new Error("network"));
  await expect(loadRealtimeCallState()).rejects.toThrow("network");
  expect(localStorage.getItem("rakazo.realtimeCallModel.user-1")).toBe("voice-model");
});

it("hands over to the standard call when realtime was switched off after the settings were read", async () => {
  realtime.get.mockResolvedValue(callState());
  const { fetch, peers } = stubMedia();
  fetch.mockResolvedValueOnce(new Response("off", { status: 409 }));
  const onUnavailable = vi.fn();
  const onFailure = vi.fn();
  open({ onUnavailable, onFailure });
  await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalledOnce());
  expect(onFailure).not.toHaveBeenCalled();
  expect(peers[0]?.close).toHaveBeenCalledOnce();
});
