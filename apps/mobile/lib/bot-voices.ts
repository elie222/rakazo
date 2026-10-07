import { File, Paths } from "expo-file-system";
import type { Voice } from "expo-speech";
import { getActiveUiLocale } from "./i18n";
import { pickUnusedVoice } from "./voice-assignment";

/** Which on-device voice each bot speaks with. Lives on this phone only, like the voice itself. */
function assignmentsFile(): File {
  return new File(Paths.document, "rakazo-bot-voices.json");
}

async function loadAssignments(): Promise<Record<string, string>> {
  try {
    const file = assignmentsFile();
    if (!file.exists) return {};
    const parsed: unknown = JSON.parse(await file.text());
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveAssignments(assignments: Record<string, string>): void {
  const file = assignmentsFile();
  if (!file.exists) file.create();
  file.write(JSON.stringify(assignments));
}

/**
 * Every read-change-write of the assignments runs after the previous one, so two bots
 * speaking at once never both take the same free voice or drop each other's entry.
 */
let assignmentQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = assignmentQueue.then(work, work);
  assignmentQueue = run.catch(() => undefined);
  return run;
}

let speechModule: Promise<typeof import("expo-speech")> | undefined;
function loadSpeech() {
  speechModule ??= import("expo-speech").catch((error: unknown) => {
    speechModule = undefined;
    throw error;
  });
  return speechModule;
}

type ListedVoice = Voice & { localService?: boolean; requiresNetwork?: boolean };

/**
 * Network voices upload the text they speak. Android marks that with
 * `requiresNetwork` (see the expo-speech patch); the web engine uses `localService`;
 * older engines only encode it in the id. Any one of those keeps the voice off the list.
 */
function isNetworkVoice(voice: ListedVoice): boolean {
  if (voice.requiresNetwork === true) return true;
  if (voice.localService === false) return true;
  return /network/i.test(voice.identifier) || /network/i.test(voice.name ?? "");
}

/**
 * iOS novelty voices (Bubbles, Zarvox, and the rest of that set). A person can still
 * pick one; auto-assignment never does.
 */
const NOVELTY_VOICE_NAMES = new Set([
  "albert",
  "badnews",
  "bahh",
  "bells",
  "boing",
  "bubbles",
  "cellos",
  "deranged",
  "goodnews",
  "hysterical",
  "jester",
  "junior",
  "organ",
  "princess",
  "ralph",
  "superstar",
  "trinoids",
  "whisper",
  "wobble",
  "zarvox",
]);

function noveltyKey(voice: { identifier: string; name?: string }): string {
  const named = voice.name?.trim();
  const source = named && named !== voice.identifier ? named : voice.identifier;
  const leaf = source.split(/[./]/).pop() ?? source;
  return leaf.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isNoveltyVoice(voice: { identifier: string; name?: string }): boolean {
  return NOVELTY_VOICE_NAMES.has(noveltyKey(voice));
}

/**
 * The engine's offline voices, in the app's language when it has some. Network voices
 * are removed before that choice, and nothing puts them back.
 */
export async function deviceVoices(): Promise<Voice[]> {
  const Speech = await loadSpeech();
  const offline = ((await Speech.getAvailableVoicesAsync()) as ListedVoice[]).filter(
    (voice) => !isNetworkVoice(voice),
  );
  const language = getActiveUiLocale().split("-")[0]?.toLowerCase() ?? "en";
  const sameLanguage = offline.filter((voice) =>
    voice.language?.toLowerCase().startsWith(language),
  );
  return (sameLanguage.length > 0 ? sameLanguage : offline).sort((a, b) =>
    a.identifier.localeCompare(b.identifier),
  );
}

/** "en-us-x-iol-local" reads as "en-US · iol": the engine's names are ids, not labels. */
export function voiceLabel(voice: Voice): string {
  const code = voice.identifier.match(/-x-([a-z0-9]+)-/i)?.[1];
  const name = code ?? (voice.name !== voice.identifier ? voice.name : voice.identifier);
  return voice.language ? `${voice.language} · ${name}` : name;
}

/** The voice a bot speaks with, handing it one no other bot has yet if it has none. */
export function voiceForBot(botId: string): Promise<string | undefined> {
  return serialized(async () => {
    const available = await deviceVoices();
    const voices = available.map((voice) => voice.identifier);
    if (voices.length === 0) return undefined;
    const assignments = await loadAssignments();
    const current = assignments[botId];
    if (current && voices.includes(current)) return current;
    const assignable = available
      .filter((voice) => !isNoveltyVoice(voice))
      .map((voice) => voice.identifier);
    if (assignable.length === 0) return undefined;
    const taken = new Set(
      Object.entries(assignments)
        .filter(([id]) => id !== botId)
        .map(([, voice]) => voice),
    );
    const picked = pickUnusedVoice(assignable, taken, botId);
    saveAssignments({ ...assignments, [botId]: picked });
    return picked;
  });
}

export function setVoiceForBot(botId: string, voiceId: string): Promise<void> {
  return serialized(async () => {
    saveAssignments({ ...(await loadAssignments()), [botId]: voiceId });
  });
}
