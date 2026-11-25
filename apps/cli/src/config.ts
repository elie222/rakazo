import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type CliConfig = { url: string; key: string };

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "rakazo", "config.json");
}

/** The server and key to use: environment first, then what `rakazo login` saved. */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<CliConfig | null> {
  const fromEnv = (url: string, key: string) => ({ url: url.replace(/\/+$/, ""), key });
  // The environment alone is enough; a broken saved file must not stand in its way.
  if (env.RAKAZO_URL && env.RAKAZO_API_KEY) return fromEnv(env.RAKAZO_URL, env.RAKAZO_API_KEY);
  let saved: Partial<CliConfig> = {};
  try {
    saved = JSON.parse(await readFile(configPath(env), "utf8")) as Partial<CliConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const url = env.RAKAZO_URL || saved.url;
  // A saved key goes only to the server it was saved for, never to one the environment names.
  const sameServer = !env.RAKAZO_URL || env.RAKAZO_URL.replace(/\/+$/, "") === saved.url;
  const key = env.RAKAZO_API_KEY || (sameServer ? saved.key : undefined);
  return url && key ? { url: url.replace(/\/+$/, ""), key } : null;
}

/** Saved readable by this user only, since the key acts as them. */
export async function saveConfig(
  config: CliConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const file = configPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // A mode given on creation leaves an existing folder or file as open as it was.
  await chmod(path.dirname(file), 0o700);
  // A new file replaces the old one, so the key never sits in a file others can read.
  const fresh = `${file}.${process.pid}.tmp`;
  await writeFile(fresh, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(fresh, file);
  return file;
}
