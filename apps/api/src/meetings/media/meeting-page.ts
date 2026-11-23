import { MEETING_MEDIA_PATH } from "@rakazo/adapters/meeting-media";
import { MEETING_SAMPLE_RATE } from "./meeting-audio.js";

export const meetingPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rakazo</title>
<link rel="stylesheet" href="${MEETING_MEDIA_PATH}/tile.css">
<script src="${MEETING_MEDIA_PATH}/bridge.js" defer></script>
</head>
<body>
<main>
  <img src="${MEETING_MEDIA_PATH}/mark.webp" alt="Rakazo" width="96" height="96">
  <h1></h1>
</main>
</body>
</html>`;

export const meetingTileStyles = `
:root { color-scheme: dark; font: 1rem system-ui, sans-serif; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { display: grid; justify-items: center; gap: 1.5rem; width: min(90vw, 42rem); text-align: center; }
img { width: clamp(3rem, 15vw, 6rem); height: auto; }
h1 { margin: 0; font-size: clamp(1.25rem, 5vw, 2.5rem); font-weight: 600; overflow-wrap: anywhere; }
h1:empty { display: none; }
`;

/** AudioWorklet processes audio off the camera page's rendering thread. */
export const meetingAudioWorklet = `
class MeetingInput extends AudioWorkletProcessor {
  frames = new Float32Array(1024);
  offset = 0;

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (const sample of samples) {
      this.frames[this.offset++] = sample;
      if (this.offset === this.frames.length) {
        this.port.postMessage(this.frames, [this.frames.buffer]);
        this.frames = new Float32Array(1024);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("meeting-input", MeetingInput);
`;

export const meetingBridgeScript = `
const base = ${JSON.stringify(MEETING_MEDIA_PATH)};
// Keep the signed grant through reloads. The fragment is never sent in HTTP requests.
const grant = location.hash.slice(1);
const headers = { Authorization: "Bearer " + grant };
const sampleRate = ${MEETING_SAMPLE_RATE};
const noiseThreshold = 0.025;
const preRollLimit = 5;
const maxTurnFrames = 200;
const silenceFrames = 8;

let audio, microphone, processor, playback, pending;
let queued;
let preRoll = [];
let utterance = [];
let voiced = 0;
let quiet = 0;
let closed = false;
let context;

function interruptPlayback() {
  const interrupted = playback;
  playback = undefined;
  interrupted?.stop();
}

async function respond(frames) {
  const request = new AbortController();
  pending = request;
  try {
    const samples = new DataView(new ArrayBuffer(frames.length * frames[0].length * 2));
    let offset = 0;
    for (const frame of frames) {
      for (const sample of frame) {
        samples.setInt16(offset, Math.max(-1, Math.min(1, sample)) * 32767, true);
        offset += 2;
      }
    }

    const response = await fetch(base + "/turn", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        ...(context ? { "X-Meeting-Context": context } : {}),
      },
      body: samples.buffer,
      signal: request.signal,
      credentials: "omit",
    });
    if (response.status === 401 || response.status === 403) close();
    if (!response.ok || request.signal.aborted) return;
    context = response.headers.get("X-Meeting-Context") ?? context;
    if (response.status === 204 || queued || utterance.length > 0) return;
    const spokenContext = response.headers.get("X-Meeting-Spoken-Context");
    const clip = await audio.decodeAudioData(await response.arrayBuffer());
    if (request.signal.aborted || queued || utterance.length > 0) return;

    const source = audio.createBufferSource();
    source.buffer = clip;
    source.connect(audio.destination);
    source.onended = () => {
      if (playback !== source) return;
      playback = undefined;
      context = spokenContext ?? context;
    };
    playback = source;
    source.start();
  } catch {
    if (!request.signal.aborted) console.warn("Meeting reply playback failed");
  } finally {
    pending = undefined;
    const next = queued;
    queued = undefined;
    if (next && !closed) void respond(next);
  }
}

function frame({ data: samples }) {
  const energy = samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length;
  const speaking = energy >= noiseThreshold * noiseThreshold;
  if (utterance.length === 0) {
    preRoll.push(samples);
    if (preRoll.length > preRollLimit) preRoll.shift();
    voiced = speaking ? voiced + 1 : 0;
    if (voiced < 3) return;
    interruptPlayback();
    utterance = preRoll;
    preRoll = [];
    quiet = 0;
    return;
  }

  utterance.push(samples);
  quiet = speaking ? 0 : quiet + 1;
  if (quiet < silenceFrames && utterance.length < maxTurnFrames) return;
  const frames = utterance;
  utterance = [];
  voiced = 0;
  if (pending) queued = [...(queued ?? []), ...frames].slice(-maxTurnFrames);
  else void respond(frames);
}

function close() {
  closed = true;
  pending?.abort();
  queued = undefined;
  interruptPlayback();
  processor?.disconnect();
  processor?.port.close();
  microphone?.getTracks().forEach((track) => track.stop());
  if (audio && audio.state !== "closed") void audio.close().catch(() => {
    console.warn("Meeting audio could not close");
  });
}

async function start() {
  if (!grant) return;
  const response = await fetch(base + "/session", { headers, credentials: "omit" });
  if (!response.ok || closed) return;
  const session = await response.json();
  document.querySelector("h1").textContent = session.botName + " · Rakazo";
  if (!session.voice) return;

  microphone = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  if (closed) {
    close();
    return;
  }
  audio = new AudioContext({ sampleRate });
  await audio.audioWorklet.addModule(base + "/audio-worklet.js");
  await audio.resume();
  processor = new AudioWorkletNode(audio, "meeting-input", { numberOfOutputs: 0 });
  processor.port.onmessage = frame;
  audio.createMediaStreamSource(microphone).connect(processor);
}

window.addEventListener("pagehide", close, { once: true });
// A cached document has released its microphone and must authenticate again when restored.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
void start().catch(() => {
  close();
  console.warn("Meeting audio could not start");
});
`;
