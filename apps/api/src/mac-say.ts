import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";

export type MacVoiceQuality = "premium" | "enhanced" | "standard";

export type MacVoice = {
  name: string;
  quality: MacVoiceQuality;
};

const SAY_BIN = "/usr/bin/say";
const MAX_SAY_CHARS = 4_000;
const SAY_TIMEOUT_MS = 120_000;
const QUALITY_RANK: Record<MacVoiceQuality, number> = {
  premium: 0,
  enhanced: 1,
  standard: 2,
};

type SayRunner = (voice: string, text: string) => Promise<void>;

export function macSayAvailable(platform = process.platform, bin = SAY_BIN): boolean {
  if (platform !== "darwin") return false;
  try {
    accessSync(bin, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `Daniel (English (UK))` keeps its locale. Only a trailing quality mark is special. */
export function parseMacVoice(line: string): MacVoice | null {
  const name = line.split("#")[0]?.trim() ?? "";
  const voice = name.replace(/\s+[a-z]{2}_[A-Z]{2}\s*$/, "").trim();
  if (!voice) return null;
  const quality = voice.endsWith("(Premium)")
    ? "premium"
    : voice.endsWith("(Enhanced)")
      ? "enhanced"
      : "standard";
  return { name: voice, quality };
}

export function parseMacVoices(output: string): MacVoice[] {
  const voices = output
    .split("\n")
    .map(parseMacVoice)
    .filter((voice): voice is MacVoice => voice !== null);
  return voices.sort(
    (left, right) =>
      QUALITY_RANK[left.quality] - QUALITY_RANK[right.quality] ||
      left.name.localeCompare(right.name),
  );
}

/** `macos:Zoe (Premium)` and `Zoe` both resolve to the installed `Zoe (Premium)`. */
export function resolveMacVoiceName(name: string, voices: readonly MacVoice[]): string | null {
  const requested = name.replace(/^macos:/, "").trim();
  if (!requested) return null;
  const exact = voices.find((voice) => voice.name === requested);
  if (exact) return exact.name;
  return (
    voices.find((voice) => voice.name.replace(/\s+\((?:Premium|Enhanced)\)$/, "") === requested)
      ?.name ?? null
  );
}

export function macVoiceInstalled(name: string, voices: readonly MacVoice[]): boolean {
  return resolveMacVoiceName(name, voices) !== null;
}

export function macVoicePreview(name: string): string {
  const spoken = name
    .replace(/\s+\((?:Premium|Enhanced)\)$/, "")
    .replace(/\s+\(.*\)$/, "")
    .trim();
  return `Hi, I'm ${spoken || name}.`;
}

export function sanitizeSayText(text: string): string {
  let cleaned = "";
  for (const character of text) {
    const code = character.charCodeAt(0);
    cleaned += code < 32 || code === 127 ? " " : character;
  }
  return cleaned.replace(/\s+/g, " ").trim().slice(0, MAX_SAY_CHARS);
}

export class MacSaySpeaker {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly voices: () => Promise<MacVoice[]>,
    private readonly say: SayRunner,
  ) {}

  list(): Promise<MacVoice[]> {
    return this.voices();
  }

  enqueue(voice: string, text: string): Promise<void> {
    const spoken = sanitizeSayText(text);
    const job = this.queue.then(async () => {
      if (!spoken) return;
      const installed = await this.voices();
      const name = resolveMacVoiceName(voice, installed);
      if (!name) throw new Error(`Mac voice "${voice}" is not installed.`);
      await this.say(name, spoken);
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
}

export function createMacSaySpeaker(): MacSaySpeaker | null {
  if (!macSayAvailable()) return null;
  return new MacSaySpeaker(listInstalledMacVoices, speakWithSay);
}

export async function listInstalledMacVoices(): Promise<MacVoice[]> {
  const output = await runSay(["-v", "?"], 10_000);
  return parseMacVoices(output);
}

export function speakWithSay(voice: string, text: string): Promise<void> {
  return runSay(["-v", voice, "-r", "200", text], SAY_TIMEOUT_MS).then(() => undefined);
}

function runSay(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(SAY_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("macOS say timed out."));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `macOS say exited ${code}.`));
    });
  });
}
