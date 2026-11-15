import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { IpcChannel, IpcWindow } from "./ipc-channels.js";
import { ipcChannels } from "./ipc-channels.js";

const srcDir = import.meta.dirname;
const channels: [string, IpcChannel][] = Object.entries(ipcChannels);
/** The preload of the window whose page may call: one for an app window, replaced or not. */
const PRELOADS = {
  app: "preload.cjs",
  appOrReplaced: "preload.cjs",
  setup: "setup-preload.cjs",
} as const satisfies Record<IpcWindow, string>;
type Preload = (typeof PRELOADS)[IpcWindow];

/** Channels named as string literals in `call("…"`, failing when a call names its channel any other way. */
function literalChannels(source: string, call: RegExp, file: string): string[] {
  const calls = source.match(new RegExp(call.source, "g"))?.length ?? 0;
  const named = [...source.matchAll(new RegExp(`${call.source}\\s*"([^"]+)"`, "g"))].map(
    (match) => match.at(-1) ?? "",
  );
  expect(named.length, `${file} must name every channel as a string literal`).toBe(calls);
  return named.sort();
}

function preloadChannels(file: Preload, method: "invoke" | "sendSync") {
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

  it.each(["preload.cjs", "setup-preload.cjs"] as const)(
    "exposes in %s exactly its window's channels",
    (file) => {
      const mapped = (sync: boolean) =>
        channels
          .filter(
            ([, channel]) => PRELOADS[channel.from] === file && (channel.sync === true) === sync,
          )
          .map(([name]) => name)
          .sort();
      expect(preloadChannels(file, "invoke")).toEqual(mapped(false));
      expect(preloadChannels(file, "sendSync")).toEqual(mapped(true));
    },
  );
});
