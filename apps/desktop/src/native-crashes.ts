import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ClientOperation } from "@rakazo/logging/monitoring";
import { app, crashReporter } from "electron";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

type Capture = (error: Error, operation: ClientOperation, tags: Record<string, string>) => void;
let installed = false;
let capture: Capture | undefined;
let writes: Promise<void> = Promise.resolve();
let epoch = 0;

/** Collect locally only; raw process memory is never uploaded or read by this module. */
export function configureNativeCrashReporting(base: string, next: Capture): void {
  const current = ++epoch;
  capture = next;
  if (!installed) {
    crashReporter.start({ uploadToServer: false });
    installed = true;
    const unexpected = new Set([
      "crashed",
      "oom",
      "abnormal-exit",
      "integrity-failure",
      "launch-failed",
    ]);
    app.on("render-process-gone", (_event, _contents, details) => {
      if (unexpected.has(details.reason))
        capture?.(new Error(`Renderer stopped (${details.reason})`), "desktop.renderer", {
          "native.crash": "true",
        });
    });
    app.on("child-process-gone", (_event, details) => {
      if (unexpected.has(details.reason))
        capture?.(
          new Error(`Child process stopped (${details.type}, ${details.reason})`),
          "desktop.child",
          {
            "native.crash": "true",
            "process.name": details.name ?? details.serviceName ?? details.type,
            "process.exit_code": String(details.exitCode),
          },
        );
    });
  }
  // A cached main-process dump belongs only to the connection active when it was created.
  const connection = createHash("sha256").update(base).digest("hex");
  const file = path.join(app.getPath("userData"), "native-crash-checkpoint.json");
  writes = writes
    .then(async () => {
      const saved = JSON.parse((await readPrivateFile(file, 1024)) ?? "null") as {
        connection?: string;
        checkedAt?: number;
        enabled?: boolean;
      } | null;
      if (current !== epoch) return;
      if (
        saved?.enabled &&
        saved.connection === connection &&
        typeof saved.checkedAt === "number"
      ) {
        const latest = await latestCrashTime();
        if (current !== epoch) return;
        if (latest > saved.checkedAt)
          next(
            new Error("Desktop native process crashed during the previous session"),
            "desktop.startup",
            { "native.crash": "true" },
          );
      }
      await writePrivateFile(
        file,
        JSON.stringify({ connection, checkedAt: Date.now(), enabled: true }),
      );
    })
    .catch(() => undefined);
}

export function disableNativeCrashReporting(): void {
  epoch++;
  capture = undefined;
  const file = path.join(app.getPath("userData"), "native-crash-checkpoint.json");
  writes = writes
    .then(() => writePrivateFile(file, JSON.stringify({ checkedAt: Date.now(), enabled: false })))
    .catch(() => undefined);
}

async function latestCrashTime(): Promise<number> {
  let latest = 0;
  for (const directory of [
    app.getPath("crashDumps"),
    path.join(app.getPath("crashDumps"), "pending"),
    path.join(app.getPath("crashDumps"), "completed"),
  ]) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith(".dmp")) continue;
      const metadata = await stat(path.join(directory, entry.name)).catch(() => undefined);
      latest = Math.max(latest, metadata?.mtimeMs ?? 0);
    }
  }
  return latest;
}
