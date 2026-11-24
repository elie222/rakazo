import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type CliConfig = { url: string; key: string };

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "rakazo", "config.json");
}

/** The server and key to use: environment first, then what `rakazo login` saved. */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<CliConfig | null> {
  let saved: Partial<CliConfig> = {};
  try {
    saved = JSON.parse(await readFile(configPath(env), "utf8")) as Partial<CliConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const url = env.RAKAZO_URL || saved.url;
  const key = env.RAKAZO_API_KEY || saved.key;
  return url && key ? { url: url.replace(/\/+$/, ""), key } : null;
}

/** Saved readable by this user only, since the key acts as them. */
export async function saveConfig(
  config: CliConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const file = configPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}
