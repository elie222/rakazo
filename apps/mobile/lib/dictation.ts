/**
 * On-device dictation for calls, mirroring the web store's endpoint mode: the recognizer
 * reports words, and only a quiet gap measured here ends a turn. The recognizer's own
 * `isFinal` / `end` is a breath or an OS timeout, never the caller finishing a sentence.
 */

/** Quiet gap that ends an utterance. A natural breath is well under it, a finished turn well over. */
export const ENDPOINT_SILENCE_MS = 1_200;
const RESTART_MIN_MS = 250;
const RESTART_MAX_MS = 2_000;
/** Restarts in a row that hear nothing: the recognizer is wedged, stop churning the mic. */
const MAX_DEAD_RESTARTS = 5;
/** Errors that mean this turn cannot recover; the rest are routine and `end` restarts. */
const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);

type ResultEvent = { isFinal: boolean; results: { transcript: string }[] };
type ErrorEvent = { error?: string };
type DictationEventMap = { result: ResultEvent; end: null; error: ErrorEvent };

/** The slice of `expo-speech-recognition` this module needs, so tests can drive the events. */
export type SpeechRecognizer = {
  start(options: { lang: string; interimResults: boolean; continuous: boolean }): void;
  stop(): void;
  abort(): void;
  isRecognitionAvailable(): boolean;
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  addListener<Event extends keyof DictationEventMap>(
    event: Event,
    listener: (payload: DictationEventMap[Event]) => void,
  ): { remove: () => void };
};

type Session = {
  recognizer: SpeechRecognizer;
  lang: string;
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  subs: { remove: () => void }[];
  /** Text from earlier recognizer sessions of the same utterance. */
  carried: string;
  /** Text of the recognizer session running now. */
  heard: string;
  silence?: ReturnType<typeof setTimeout>;
  restart?: ReturnType<typeof setTimeout>;
  backoff: number;
  deadRestarts: number;
};

let injected: SpeechRecognizer | null = null;
/** Test seam: an injected recognizer replaces the native module. */
export function setSpeechRecognizer(recognizer: SpeechRecognizer | null): void {
  injected = recognizer;
}

async function load(): Promise<SpeechRecognizer> {
  if (injected) return injected;
  const { ExpoSpeechRecognitionModule } = await import("expo-speech-recognition");
  return ExpoSpeechRecognitionModule as unknown as SpeechRecognizer;
}

/** A session older than this one can never deliver a final. */
let token = 0;
let active: Session | null = null;

/** True when the device can recognise speech itself and the caller allowed it. */
export async function available(): Promise<boolean> {
  try {
    const recognizer = await load();
    if (!recognizer.isRecognitionAvailable()) return false;
    return (await recognizer.requestPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

export function stop(): void {
  const session = active;
  active = null;
  token += 1;
  if (!session) return;
  clearTimeout(session.silence);
  clearTimeout(session.restart);
  for (const sub of session.subs) sub.remove();
  try {
    session.recognizer.abort();
  } catch {
    // already stopped
  }
}

/** Opens the microphone until a quiet gap ends the utterance, or `signal` aborts it. */
export async function listen(opts: {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  signal?: AbortSignal;
  lang?: string;
}): Promise<void> {
  stop();
  const mine = token;
  if (opts.signal?.aborted) return;
  const recognizer = await load();
  // A hang-up or a newer session landed while the native module was loading.
  if (token !== mine) return;
  const session: Session = {
    recognizer,
    lang: opts.lang || "en-US",
    onInterim: opts.onInterim,
    onFinal: opts.onFinal,
    subs: [],
    carried: "",
    heard: "",
    backoff: RESTART_MIN_MS,
    deadRestarts: 0,
  };
  active = session;
  opts.signal?.addEventListener(
    "abort",
    () => {
      if (active === session) stop();
    },
    { once: true },
  );
  session.subs = [
    recognizer.addListener("result", (event) => onResult(session, event)),
    recognizer.addListener("end", () => onEnd(session)),
    recognizer.addListener("error", (event) => onError(session, event)),
  ];
  start(session);
}

function start(session: Session): void {
  if (active !== session) return;
  session.recognizer.start({ lang: session.lang, interimResults: true, continuous: true });
}

function onResult(session: Session, event: ResultEvent): void {
  if (active !== session) return;
  const heard = event.results?.[0]?.transcript ?? "";
  session.backoff = RESTART_MIN_MS;
  session.deadRestarts = 0;
  // Android reports a phrase once and starts over, iOS grows one transcript: folding a
  // final into the carried text and clearing the live one covers both.
  if (event.isFinal) {
    session.carried = join(session.carried, heard);
    session.heard = "";
  } else {
    session.heard = heard;
  }
  const text = join(session.carried, session.heard);
  if (!text) return;
  session.onInterim?.(text);
  // Any result means the caller was just heard, so the quiet gap restarts here — including
  // a phrase the recognizer finalises after repeating it, whose boundary is a breath.
  clearTimeout(session.silence);
  session.silence = setTimeout(() => finish(session), ENDPOINT_SILENCE_MS);
}

function onEnd(session: Session): void {
  if (active !== session) return;
  // iOS ends a session on its own — on a pause, an interruption, or its own cap — and that
  // says nothing about whether the caller finished. Pick the microphone straight back up.
  session.carried = join(session.carried, session.heard);
  session.heard = "";
  session.deadRestarts += 1;
  if (session.deadRestarts > MAX_DEAD_RESTARTS) {
    // ponytail: a wedged recognizer just ends the turn; the call opens the mic again next
    // turn. Surface it as an error if callers ever need to tell it from a real endpoint.
    finish(session);
    return;
  }
  clearTimeout(session.restart);
  const delay = session.backoff;
  session.backoff = Math.min(RESTART_MAX_MS, session.backoff * 2);
  session.restart = setTimeout(() => {
    if (active !== session) return;
    try {
      start(session);
    } catch {
      finish(session);
    }
  }, delay);
}

function onError(session: Session, event: ErrorEvent): void {
  if (active !== session) return;
  if (!event?.error || !FATAL_ERRORS.has(event.error)) return;
  finish(session);
}

function finish(session: Session): void {
  if (active !== session) return;
  const text = join(session.carried, session.heard).trim();
  const { onFinal } = session;
  stop();
  if (text) onFinal(text);
}

function join(left: string, right: string): string {
  return `${left} ${right}`.replace(/\s+/g, " ").trim();
}
