export type DictationMode = "hold" | "endpoint";

export type DictationSnapshot = {
  status: "idle" | "listening" | "transcribing";
  transcript: string;
  error?: string;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { resultIndex: number; results: SpeechRecognitionResultList }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

const IDLE: DictationSnapshot = { status: "idle", transcript: "" };

export function webSpeechAvailable(): boolean {
  return Boolean(speechRecognitionCtor());
}

function speechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const host = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition;
}

export class Dictation {
  private snapshot: DictationSnapshot = IDLE;
  private watchers = new Set<(s: DictationSnapshot) => void>();
  private recognition: SpeechRecognitionLike | null = null;
  private media: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private token = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private transcribeAbort: AbortController | null = null;
  private onFinal: ((text: string) => void) | null = null;

  subscribe(fn: (s: DictationSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => {
      this.watchers.delete(fn);
    };
  }

  get state(): DictationSnapshot {
    return this.snapshot;
  }

  private set(next: DictationSnapshot) {
    this.snapshot = next;
    for (const watcher of [...this.watchers]) watcher(next);
  }

  stop(reason: "submit" | "cancel" | "replace" = "cancel") {
    this.token += 1;
    this.transcribeAbort?.abort();
    this.transcribeAbort = null;
    clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
    const rec = this.recognition;
    this.recognition = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        if (reason === "submit") rec.stop();
        else rec.abort();
      } catch {
        // already stopped
      }
    }
    const media = this.media;
    this.media = null;
    if (media && media.state !== "inactive") {
      try {
        media.stop();
      } catch {
        // already stopped
      }
    }
    this.chunks = [];
    this.onFinal = null;
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
  }

  async listen(opts: {
    mode: DictationMode;
    transcribe?: boolean;
    endpointMs?: number;
    onFinal: (text: string) => void;
  }): Promise<void> {
    this.stop("replace");
    const mine = this.token;
    this.onFinal = opts.onFinal;
    this.set({ status: "listening", transcript: "" });
    if (webSpeechAvailable()) {
      this.listenWebSpeech(opts.mode, opts.endpointMs ?? 850, mine);
      return;
    }
    if (opts.transcribe) {
      await this.listenRecorder(mine);
      return;
    }
    this.set({
      ...IDLE,
      error:
        "This browser has no on-device dictation. Connect a voice provider with transcription, or use Chrome / the desktop app.",
    });
  }

  private listenWebSpeech(mode: DictationMode, endpointMs: number, mine: number) {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (event) => {
      if (this.token !== mine) return;
      let transcript = "";
      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i]?.[0]?.transcript ?? "";
      }
      this.set({ status: "listening", transcript: transcript.trim() });
      if (mode !== "endpoint") return;
      clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => {
        if (this.token !== mine) return;
        const text = this.snapshot.transcript.trim();
        this.finish(text, mine);
      }, endpointMs);
    };
    rec.onerror = (event) => {
      if (this.token !== mine) return;
      if (event.error === "aborted" || event.error === "no-speech") return;
      this.set({
        ...IDLE,
        error: event.error ? `Dictation failed: ${event.error}` : "Dictation failed.",
      });
    };
    rec.onend = () => {
      if (this.token !== mine) return;
      if (mode === "hold" && this.snapshot.status === "listening") {
        this.finish(this.snapshot.transcript, mine);
      }
    };
    this.recognition = rec;
    rec.start();
  }

  private async listenRecorder(mine: number) {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (this.token !== mine) return;
      this.set({
        ...IDLE,
        error: error instanceof Error ? error.message : "Microphone failed",
      });
      return;
    }
    if (this.token !== mine) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const media = new MediaRecorder(stream);
    this.media = media;
    this.chunks = [];
    media.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data);
    };
    media.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      if (this.token !== mine) return;
      void this.transcribeChunks(mine);
    };
    media.start();
  }

  private async transcribeChunks(mine: number) {
    if (this.token !== mine) return;
    const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || "audio/webm" });
    this.chunks = [];
    if (!blob.size) {
      this.set(IDLE);
      return;
    }
    this.set({ status: "transcribing", transcript: this.snapshot.transcript });
    const abort = new AbortController();
    this.transcribeAbort = abort;
    try {
      const audioBase64 = await blobToBase64(blob);
      if (this.token !== mine) return;
      const res = await fetch("/api/voice/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ audioBase64, mimeType: blob.type }),
        signal: abort.signal,
      });
      if (this.token !== mine) return;
      const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (this.token !== mine) return;
      if (!res.ok) {
        this.set({ ...IDLE, error: body.error ?? "Could not transcribe that recording." });
        return;
      }
      this.finish(body.text ?? "", mine);
    } catch (error) {
      if (this.token !== mine) return;
      if (error instanceof Error && error.name === "AbortError") return;
      this.set({
        ...IDLE,
        error: error instanceof Error ? error.message : "Could not transcribe that recording.",
      });
    }
  }

  submitHold() {
    if (this.media && this.media.state !== "inactive") {
      this.media.stop();
      return;
    }
    this.finish(this.snapshot.transcript, this.token);
  }

  private finish(text: string, mine: number) {
    if (this.token !== mine) return;
    const trimmed = text.trim();
    const onFinal = this.onFinal;
    this.stop("submit");
    if (trimmed) onFinal?.(trimmed);
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export const dictation = new Dictation();
