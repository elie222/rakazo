import { File, Paths } from "expo-file-system";
import { currentApiBase } from "./api";
import { loadSessionToken } from "./session";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await loadSessionToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function speakUtterance(
  text: string,
  opts: { voiceId?: string; botId?: string } = {},
): Promise<Uint8Array> {
  const res = await fetch(`${currentApiBase()}/api/voice/speak`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "rakazo://",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ text, voiceId: opts.voiceId, botId: opts.botId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Voice failed (${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function playMpeg(bytes: Uint8Array): Promise<void> {
  const AudioCtor = (globalThis as { Audio?: typeof Audio }).Audio;
  if (typeof AudioCtor === "function") {
    await playWithHtmlAudio(AudioCtor, bytes);
    return;
  }
  await playWithNativeAudio(bytes);
}

async function playWithHtmlAudio(AudioCtor: typeof Audio, bytes: Uint8Array): Promise<void> {
  const blob = new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  try {
    const audio = new AudioCtor(url);
    await audio.play();
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("Could not play that clip."));
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function playWithNativeAudio(bytes: Uint8Array): Promise<void> {
  const { createAudioPlayer, setAudioModeAsync } = await import("expo-audio");
  await setAudioModeAsync({
    playsInSilentMode: true,
    interruptionMode: "mixWithOthers",
    shouldPlayInBackground: false,
  });
  const file = new File(Paths.cache, `rakazo-voice-${Date.now()}.mp3`);
  file.create({ overwrite: true });
  file.write(bytesToBase64(bytes), { encoding: "base64" });
  const player = createAudioPlayer({ uri: file.uri });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer = setTimeout(() => finish(new Error("Could not play that clip.")), 15_000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.remove();
        if (error) reject(error);
        else resolve();
      };
      const sub = player.addListener("playbackStatusUpdate", (status) => {
        if (status.error) {
          finish(new Error(status.error));
          return;
        }
        if (status.playbackState === "failed") {
          finish(new Error("Could not play that clip."));
          return;
        }
        if (status.didJustFinish) {
          finish();
          return;
        }
        if (status.playing && status.duration > 0) {
          clearTimeout(timer);
          timer = setTimeout(
            () => finish(new Error("Could not play that clip.")),
            Math.min(120_000, Math.ceil(status.duration * 1000) + 8_000),
          );
        }
      });
      try {
        player.play();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Could not play that clip."));
      }
    });
  } finally {
    player.release();
    try {
      file.delete();
    } catch {
      // already gone
    }
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
