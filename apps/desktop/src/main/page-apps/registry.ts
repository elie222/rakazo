import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PageAppConfig } from "./page-app-files.js";
import { pageAppConfig } from "./page-app-files.js";

/** `bundlePath` is the app's bundle on macOS, and its shortcut or desktop entry elsewhere. */
export type InstalledPageApp = PageAppConfig & { bundlePath: string };

const REGISTRY_FILE = "page-apps.json";

function installedApp(value: unknown): InstalledPageApp | null {
  const config = pageAppConfig(value);
  const bundlePath = (value as { bundlePath?: unknown } | null)?.bundlePath;
  return config && typeof bundlePath === "string" && path.isAbsolute(bundlePath)
    ? { ...config, bundlePath }
    : null;
}

type Recover = () => Promise<InstalledPageApp[]>;

/**
 * The apps this Rakazo installed, as recorded in its own data, whether or not their bundles
 * remain. A file that no longer parses is rebuilt from the bundles, never read as no apps, so
 * the next write cannot drop the others.
 */
export async function readRegistry(
  userDataDir: string,
  recover: Recover,
): Promise<InstalledPageApp[]> {
  let text: string;
  try {
    text = await readFile(path.join(userDataDir, REGISTRY_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let apps: unknown;
  try {
    apps = (JSON.parse(text) as { apps?: unknown }).apps;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return recover();
  }
  if (!Array.isArray(apps)) return recover();
  return apps.flatMap((value) => {
    const app = installedApp(value);
    return app ? [app] : [];
  });
}

export async function writeRegistry(userDataDir: string, apps: readonly InstalledPageApp[]) {
  const file = path.join(userDataDir, REGISTRY_FILE);
  const next = `${file}.${process.pid}.tmp`;
  await writeFile(next, `${JSON.stringify({ apps }, null, 2)}\n`, { mode: 0o600 });
  await rename(next, file);
}

/** One change at a time, so two installs finishing together both stay recorded. */
export function createRegistry(userDataDir: string, recover: Recover) {
  let queue: Promise<unknown> = Promise.resolve();
  const change = (edit: (apps: InstalledPageApp[]) => InstalledPageApp[]) => {
    const run = queue.then(async () =>
      writeRegistry(userDataDir, edit(await readRegistry(userDataDir, recover))),
    );
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return {
    list: () => queue.then(() => readRegistry(userDataDir, recover)),
    put: (app: InstalledPageApp) =>
      change((apps) => [...apps.filter((entry) => entry.appId !== app.appId), app]),
    remove: (appId: string) => change((apps) => apps.filter((entry) => entry.appId !== appId)),
  };
}
