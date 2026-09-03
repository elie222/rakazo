import { rpc, selectedSpaceId, withSpaceHeaders } from "./rpc.js";

export type SpeechStatus = "idle" | "preparing" | "speaking";

export interface SpeechSnapshot {
  status: SpeechStatus;
  botId?: string;
  messageId?: string;
  caption?: string;
  error?: string;
}

interface SpeakOptions {
  voiceId?: string;
  botId?: string;
  messageId?: string;
}

type TtsErrorBody = { error?: string };

const IDLE: SpeechSnapshot = { status: "idle" };

export class Speaker {
  private snapshot: SpeechSnapshot = IDLE;
  private watchers = new Set<(s: SpeechSnapshot) => void>();
  private token = 0;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private settlePlayback: ((finished: boolean) => void) | null = null;
  private request: AbortController | null = null;

  subscribe(fn: (s: SpeechSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => {
      this.watchers.delete(fn);
    };
  }

  get state(): SpeechSnapshot {
    return this.snapshot;
  }

  private set(next: SpeechSnapshot) {
    this.snapshot = next;
    for (const watcher of [...this.watchers]) watcher(next);
  }

  isSpeaking(messageId?: string): boolean {
    if (this.snapshot.status === "idle") return false;
    return messageId ? this.snapshot.messageId === messageId : true;
  }

  stop() {
    this.token += 1;
    this.request?.abort();
    this.request = null;
    if (this.settlePlayback) this.settlePlayback(false);
    else this.teardownAudio();
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
  }

  private teardownAudio() {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    this.stop();
    const mine = this.token;
    const controller = new AbortController();
    this.request = controller;
    const live = () => this.token === mine && !controller.signal.aborted;
    const spaceId = selectedSpaceId();

    this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });
    let utterances: string[];
    try {
      utterances = await withAbort(controller.signal, () =>
        this.prepare(text, opts, controller.signal, spaceId),
      );
    } catch (error) {
      if (live()) {
        this.set({ ...IDLE, error: error instanceof Error ? error.message : String(error) });
      }
      if (this.request === controller) this.request = null;
      return;
    }
    if (!live()) return;
    if (!utterances.length) {
      this.set(IDLE);
      if (this.request === controller) this.request = null;
      return;
    }

    type Rendered = { blob: Blob; error?: never } | { blob?: never; error: unknown };
    const render = (utterance: string): Promise<Rendered> =>
      this.render(utterance, opts, controller.signal, spaceId).then(
        (blob) => ({ blob }),
        (error: unknown) => ({ error }),
      );
    let next: Promise<Rendered> | null = render(utterances[0] ?? "");
    for (let i = 0; i < utterances.length; i += 1) {
      const current = next;
      next = i + 1 < utterances.length ? render(utterances[i + 1] ?? "") : null;
      if (!current) break;
      const rendered = await current;
      if ("error" in rendered) {
        if (live()) {
          this.set({
            ...IDLE,
            error:
              rendered.error instanceof Error ? rendered.error.message : String(rendered.error),
          });
        }
        if (this.request === controller) this.request = null;
        return;
      }
      if (!live()) return;
      this.set({
        status: "speaking",
        botId: opts.botId,
        messageId: opts.messageId,
        caption: utterances[i],
      });
      const finished = await this.play(rendered.blob, live);
      if (!finished || !live()) {
        if (live()) this.set(IDLE);
        if (this.request === controller) this.request = null;
        return;
      }
    }
    if (live()) this.set(IDLE);
    if (this.request === controller) this.request = null;
  }

  private async prepare(
    text: string,
    opts: SpeakOptions,
    signal: AbortSignal,
    spaceId: string | null,
  ): Promise<string[]> {
    const body = await rpc.voice.prepare(
      { text, voiceId: opts.voiceId, botId: opts.botId },
      { signal, context: { spaceId } },
    );
    if (!body.ready) {
      throw new Error("Add a voice provider key and pick a voice in Voice settings.");
    }
    return body.utterances ?? [];
  }

  private async render(
    text: string,
    opts: SpeakOptions,
    signal: AbortSignal,
    spaceId: string | null,
  ): Promise<Blob> {
    const res = await fetch("/api/voice/speak", {
      method: "POST",
      headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
      credentials: "include",
      body: JSON.stringify({ text, voiceId: opts.voiceId, botId: opts.botId }),
      signal,
    });
    if (!res.ok) {
      const body: TtsErrorBody = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `the voice service returned ${res.status}`);
    }
    return res.blob();
  }

  private play(blob: Blob, live: () => boolean): Promise<boolean> {
    return new Promise((resolve) => {
      if (!live()) return resolve(false);
      this.teardownAudio();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      this.objectUrl = url;
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        if (this.settlePlayback === done) this.settlePlayback = null;
        if (this.audio === audio) this.teardownAudio();
        resolve(ok);
      };
      this.settlePlayback = done;
      audio.onended = () => done(true);
      audio.onerror = () => done(false);
      audio.play().catch(() => done(false));
    });
  }
}

export const speaker = new Speaker();

function withAbort<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    run().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
