import { File, Paths } from "expo-file-system";
import { getLocales } from "expo-localization";
import type * as ExpoSpeech from "expo-speech";
import type { Voice } from "expo-speech";
import { Platform } from "react-native";
import { getActiveUiLocale } from "./i18n";
import { pickUnusedVoice } from "./voice-assignment";

// Assignments stay on this device.
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

// Serialize assignment updates so concurrent bots keep distinct voices.
let assignmentQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = assignmentQueue.then(work, work);
  assignmentQueue = run.catch(() => undefined);
  return run;
}

let speechModule: Promise<typeof ExpoSpeech> | undefined;
function loadSpeech() {
  speechModule ??= import("expo-speech").catch((error: unknown) => {
    speechModule = undefined;
    throw error;
  });
  return speechModule;
}

type ListedVoice = Voice & { localService?: boolean; requiresNetwork?: boolean };

function isNetworkVoice(voice: ListedVoice): boolean {
  if (voice.requiresNetwork === true) return true;
  if (voice.localService === false) return true;
  return /network/i.test(voice.identifier) || /network/i.test(voice.name ?? "");
}

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

function isNoveltyVoice(voice: { identifier: string; name?: string }): boolean {
  return NOVELTY_VOICE_NAMES.has(noveltyKey(voice));
}

const PRIMARY_LOCALES: Readonly<Record<string, string>> = {
  en: "en-us",
  de: "de-de",
  ru: "ru-ru",
  zh: "zh-cn",
  fr: "fr-fr",
  es: "es-es",
  ja: "ja-jp",
};

export async function deviceVoices(): Promise<Voice[]> {
  const Speech = await loadSpeech();
  const locale = getLocales()[0]?.languageTag ?? getActiveUiLocale();
  const language = locale.split("-")[0]?.toLowerCase() ?? "en";
  return ((await Speech.getAvailableVoicesAsync()) as ListedVoice[])
    .filter(
      (voice) =>
        !isNetworkVoice(voice) &&
        (Platform.OS !== "android" || /-local$/i.test(voice.identifier)) &&
        !isNoveltyVoice(voice) &&
        voice.language?.toLowerCase().split("-")[0] === language,
    )
    .sort((a, b) => a.identifier.localeCompare(b.identifier));
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
    const taken = new Set(
      Object.entries(assignments)
        .filter(([id]) => id !== botId)
        .map(([, voice]) => voice),
    );
    const deviceLocale = getLocales()[0];
    const locale = (deviceLocale?.languageTag ?? getActiveUiLocale()).toLowerCase();
    const region = deviceLocale?.regionCode?.toLowerCase();
    const sameLocale = available.filter((voice) => {
      const tag = voice.language.toLowerCase();
      return tag === locale || (region && tag.split("-").slice(1).includes(region));
    });
    const primaryLocale = PRIMARY_LOCALES[locale.split("-")[0] ?? ""];
    const primaryRegion = available.filter(
      (voice) => voice.language.toLowerCase() === primaryLocale,
    );
    const candidates = sameLocale.length
      ? sameLocale
      : primaryRegion.length
        ? primaryRegion
        : available;
    const unused = candidates.filter((voice) => !taken.has(voice.identifier));
    const pool = unused.length ? unused : candidates;
    const higherQuality = pool.filter(
      (voice) => voice.quality === "Enhanced" || (voice.quality as string) === "Premium",
    );
    const assignable = (higherQuality.length ? higherQuality : pool).map(
      (voice) => voice.identifier,
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
