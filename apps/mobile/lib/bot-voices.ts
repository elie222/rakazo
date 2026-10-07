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

/** The engine's offline voices in the app's language, falling back to whatever it has. */
export async function deviceVoices(): Promise<Voice[]> {
  const Speech = await import("expo-speech");
  const all = await Speech.getAvailableVoicesAsync();
  const language = getActiveUiLocale().split("-")[0]?.toLowerCase() ?? "en";
  const sameLanguage = all.filter((voice) => voice.language?.toLowerCase().startsWith(language));
  const pool = sameLanguage.length > 0 ? sameLanguage : all;
  // Network voices stream from the engine's servers; on-device voice should stay on device.
  const offline = pool.filter((voice) => !/network/i.test(voice.identifier));
  return (offline.length > 0 ? offline : pool).sort((a, b) =>
    a.identifier.localeCompare(b.identifier),
  );
}

/** The voice a bot speaks with, handing it one no other bot has yet if it has none. */
export async function voiceForBot(botId: string): Promise<string | undefined> {
  const voices = (await deviceVoices()).map((voice) => voice.identifier);
  if (voices.length === 0) return undefined;
  const assignments = await loadAssignments();
  const current = assignments[botId];
  if (current && voices.includes(current)) return current;
  const taken = new Set(
    Object.entries(assignments)
      .filter(([id]) => id !== botId)
      .map(([, voice]) => voice),
  );
  const picked = pickUnusedVoice(voices, taken, botId);
  saveAssignments({ ...assignments, [botId]: picked });
  return picked;
}

export async function setVoiceForBot(botId: string, voiceId: string): Promise<void> {
  saveAssignments({ ...(await loadAssignments()), [botId]: voiceId });
}
