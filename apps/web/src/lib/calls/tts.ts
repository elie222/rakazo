import { t } from "@lingui/core/macro";
import type { SettingsScope } from "@rakazo/contracts";
import type { SpeechFeed } from "@rakazo/core";
import {
  createSpeechFeed,
  readVoiceAudio,
  readVoiceError,
  requestDeadline,
  VOICE_RESPONSE_TIMEOUT_MS,
  withAbort,
} from "@rakazo/core";
import { rpc, selectedSpaceId, withSpaceHeaders } from "../query/rpc.js";
import { errorText, voiceAccountErrorText } from "../query/user-error.js";

import { ensureVoiceConsent, invalidateVoiceConsent } from "./voice-consent.js";

export type SpeechStatus = "idle" | "preparing" | "speaking";

export interface SpeechSnapshot {
  status: SpeechStatus;
  botId?: string;
  messageId?: string;
  caption?: string;
  error?: string;
}

interface SpeakOptions {
  callId?: string;
  spaceId?: string | null;
  /** Which copy of the voice settings to use; omitted means whichever applies in the space. */
  scope?: SettingsScope;
  voiceId?: string;
  botId?: string;
  messageId?: string;
}

const IDLE: SpeechSnapshot = { status: "idle" };

/** The failure when no voice is connected; callers can offer Voice settings for it. */
export function voiceNotReadyText(): string {
  return t`Add a voice provider key and pick a voice in Voice settings.`;
}
const SILENT_CLIP =
  "data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

type PlaybackEnd = "ended" | "stopped" | "blocked" | "failed";

/** A clip the browser would not play: autoplay blocked, or audio it cannot decode. */
class PlaybackError extends Error {
  constructor(readonly blocked: boolean) {
    super(t`Could not play that clip.`);
  }
}

export class Speaker {
  private snapshot: SpeechSnapshot = IDLE;
  private watchers = new Set<(s: SpeechSnapshot) => void>();
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private settlePlayback: ((end: PlaybackEnd) => void) | null = null;
  private served: string | null = null;
  private feed: SpeechFeed | null = null;
  /** Texts the current feed has not finished saying. */
  private queued = 0;
  /** The message the speech under way reads, for the thread to show and stop it. */
  private messageId: string | undefined;

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

  /** The voice the server used for the latest request, set only when it was not the one asked for. */
  get substitutedVoice(): string | null {
    return this.served;
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
    this.feed?.stop();
    this.feed = null;
    this.queued = 0;
    if (this.settlePlayback) this.settlePlayback("stopped");
    else this.teardownAudio();
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
  }

  unlock() {
    if (this.settlePlayback) return;
    const audio = this.element();
    audio.src = SILENT_CLIP;
    void audio.play().catch(() => undefined);
  }

  private element(): HTMLAudioElement {
    this.audio ??= new Audio();
    return this.audio;
  }

  private teardownAudio() {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  /** Resolves with this request's failure text; stopping or superseding it resolves with none. */
  speak(text: string, opts: SpeakOptions = {}): Promise<string | undefined> {
    this.stop();
    this.served = null;
    return this.queue(text, opts);
  }

  /**
   * Says `text` once everything already queued has been said, as a call does with a reply it
   * speaks while the bot still writes it. Settles like `speak`. Options apply when nothing is
   * queued or still playing; later text joins the speech already under way.
   */
  async queue(text: string, opts: SpeakOptions = {}): Promise<string | undefined> {
    // Speech that already played to the end does not carry its options, such as the message
    // it read, over to this text.
    if (!this.feed || this.feed.stopped || this.queued === 0) {
      this.feed?.stop();
      this.feed = this.newFeed(opts);
      this.messageId = opts.messageId;
    }
    const feed = this.feed;
    if (this.snapshot.status === "idle") {
      this.set({ status: "preparing", botId: opts.botId, messageId: this.messageId });
    }
    this.queued += 1;
    try {
      await feed.push(text);
    } catch (error) {
      if (this.feed !== feed) return undefined;
      this.feed = null;
      this.queued = 0;
      const failure = error instanceof PlaybackError ? error.message : errorText(error);
      this.set({ ...IDLE, error: failure });
      // A blocked autoplay shows in the speech state; a toast for it would only repeat it.
      return error instanceof PlaybackError && error.blocked ? undefined : failure;
    }
    // Stopped, or replaced by newer speech, which owns the state now.
    if (this.feed !== feed) return undefined;
    this.queued -= 1;
    if (this.queued === 0) this.set(IDLE);
    return undefined;
  }

  /** The speech under way now reads this message, such as a reply said before it landed. */
  relabel(messageId: string) {
    if (!this.feed) return;
    this.messageId = messageId;
    if (this.snapshot.status !== "idle") this.set({ ...this.snapshot, messageId });
  }

  private newFeed(opts: SpeakOptions): SpeechFeed {
    const spaceId = opts.spaceId ?? selectedSpaceId();
    return createSpeechFeed<Blob>({
      prepare: (text, signal) => withAbort(this.prepare(text, opts, signal, spaceId), signal),
      render: (utterance, signal) => this.render(utterance, opts, signal, spaceId),
      play: async (blob, utterance, signal) => {
        this.set({
          status: "speaking",
          botId: opts.botId,
          messageId: this.messageId,
          caption: utterance,
        });
        const end = await this.play(blob, signal);
        if (end === "failed" || end === "blocked") throw new PlaybackError(end === "blocked");
      },
    });
  }

  private async prepare(
    text: string,
    opts: SpeakOptions,
    signal: AbortSignal,
    spaceId: string | null,
  ): Promise<string[]> {
    await ensureVoiceConsent(spaceId, opts.scope, signal);
    signal.throwIfAborted();
    const body = await rpc.voice.prepare(
      { text, voiceId: opts.voiceId, botId: opts.botId, scope: opts.scope },
      { signal, context: { spaceId } },
    );
    if (!body.ready) {
      throw new Error(voiceNotReadyText());
    }
    return body.utterances ?? [];
  }

  private async render(
    text: string,
    opts: SpeakOptions,
    signal: AbortSignal,
    spaceId: string | null,
  ): Promise<Blob> {
    const deadline = requestDeadline(
      VOICE_RESPONSE_TIMEOUT_MS,
      t`Voice request timed out.`,
      signal,
    );
    try {
      const res = await withAbort(
        fetch("/api/voice/speak", {
          method: "POST",
          headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
          credentials: "include",
          body: JSON.stringify({
            text,
            voiceId: opts.voiceId,
            botId: opts.botId,
            scope: opts.scope,
            callId: opts.callId,
          }),
          signal: deadline.signal,
        }),
        deadline.signal,
      );
      if (!res.ok) {
        const body = await readVoiceError(res, deadline.signal);
        if (body.code === "AI_CONSENT_REQUIRED") invalidateVoiceConsent();
        throw new Error(voiceAccountErrorText(body) ?? body.error ?? "");
      }
      // A superseded request must not overwrite the voice of the one that replaced it.
      const served = res.headers.get("x-voice-id");
      if (served && served !== opts.voiceId && !signal.aborted) this.served = served;
      const bytes = await readVoiceAudio(res, deadline.signal);
      return new Blob([new Uint8Array(bytes)], {
        type: res.headers.get("content-type") ?? "audio/mpeg",
      });
    } finally {
      deadline.dispose();
    }
  }

  private play(blob: Blob, signal: AbortSignal): Promise<PlaybackEnd> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve("stopped");
      this.teardownAudio();
      const url = URL.createObjectURL(blob);
      const audio = this.element();
      audio.src = url;
      this.objectUrl = url;
      let settled = false;
      const done = (end: PlaybackEnd) => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        signal.removeEventListener("abort", stopped);
        if (this.settlePlayback === done) this.settlePlayback = null;
        this.teardownAudio();
        resolve(end);
      };
      const stopped = () => done("stopped");
      signal.addEventListener("abort", stopped);
      this.settlePlayback = done;
      audio.onended = () => done("ended");
      audio.onerror = () => done("failed");
      audio
        .play()
        .catch((error: unknown) =>
          done(
            (error as { name?: unknown } | null)?.name === "NotAllowedError" ? "blocked" : "failed",
          ),
        );
    });
  }
}

export const speaker = new Speaker();
