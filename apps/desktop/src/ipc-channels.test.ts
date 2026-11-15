import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { IpcChannel, IpcWindow } from "./ipc-channels.js";
import { ipcChannels } from "./ipc-channels.js";

const srcDir = import.meta.dirname;
const channels: [string, IpcChannel][] = Object.entries(ipcChannels);
const PRELOADS: Record<IpcWindow, string> = { app: "preload.cjs", setup: "setup-preload.cjs" };

/** Channels named as string literals in `call("…"`, failing when a call names its channel any other way. */
function literalChannels(source: string, call: RegExp, file: string): string[] {
  const calls = source.match(new RegExp(call.source, "g"))?.length ?? 0;
  const named = [...source.matchAll(new RegExp(`${call.source}\\s*"([^"]+)"`, "g"))].map(
    (match) => match.at(-1) ?? "",
  );
  expect(named.length, `${file} must name every channel as a string literal`).toBe(calls);
  return named.sort();
}

function preloadChannels(window: IpcWindow, method: "invoke" | "sendSync") {
  const file = PRELOADS[window];
  const source = readFileSync(path.join(srcDir, file), "utf8");
  expect(source, `${file} must not send one-way messages`).not.toMatch(/ipcRenderer\.send\(/);
  return literalChannels(source, new RegExp(`ipcRenderer\\.${method}\\(`), file);
}

function handledChannels() {
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "ipc.ts")
    .flatMap((file) =>
      literalChannels(readFileSync(path.join(srcDir, file), "utf8"), /\bhandleIpc\(/, file),
    )
    .sort();
}

describe("desktop IPC channels", () => {
  it("handles every channel in the map exactly once", () => {
    expect(handledChannels()).toEqual(channels.map(([name]) => name).sort());
  });

  it.each(["app", "setup"] as const)("exposes exactly the %s window's channels", (window) => {
    const mapped = (sync: boolean) =>
      channels
        .filter(([, channel]) => channel.from === window && (channel.sync === true) === sync)
        .map(([name]) => name)
        .sort();
    expect(preloadChannels(window, "invoke")).toEqual(mapped(false));
    expect(preloadChannels(window, "sendSync")).toEqual(mapped(true));
  });
});
