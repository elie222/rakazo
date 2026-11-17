import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ManagedVoiceProfile } from "@rakazo/contracts";
import { ManagedVoiceProfilesFileSchema } from "@rakazo/contracts";

const FILE_NAME = "managed-voice-profiles.json";
const MAX_FILE_BYTES = 64 * 1024;
const MAX_SETTINGS_BYTES = 16 * 1024;

export interface ManagedVoiceProfiles {
  forBot(botId: string): ManagedVoiceProfile | undefined;
}

const EMPTY: ManagedVoiceProfiles = { forBot: () => undefined };

export async function loadManagedVoiceProfiles(dataDir: string): Promise<ManagedVoiceProfiles> {
  const path = join(dataDir, FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(path, { encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw fileError(error);
  }
  if (Buffer.byteLength(raw) > MAX_FILE_BYTES) {
    throw fileError(new Error("file is too large"));
  }

  try {
    const parsed = ManagedVoiceProfilesFileSchema.parse(JSON.parse(raw));
    const profiles = new Map<string, ManagedVoiceProfile>();
    for (const profile of parsed.profiles) {
      if (profiles.has(profile.botId)) throw new Error(`duplicate botId ${profile.botId}`);
      if (
        profile.settings &&
        Buffer.byteLength(JSON.stringify(profile.settings)) > MAX_SETTINGS_BYTES
      ) {
        throw new Error(`settings for botId ${profile.botId} are too large`);
      }
      profiles.set(profile.botId, Object.freeze(profile));
    }
    return { forBot: (botId) => profiles.get(botId) };
  } catch (error) {
    throw fileError(error);
  }
}

function fileError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${FILE_NAME}: ${message}`, { cause: error });
}
