import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { IpcChannel, IpcWindow } from "./ipc-channels.js";
import { ipcChannels } from "./ipc-channels.js";

const mainDir = path.resolve(import.meta.dirname, "..");
const srcDir = path.resolve(mainDir, "..");
const channels: [string, IpcChannel][] = Object.entries(ipcChannels);
/** The preload of the window whose page may call: one for an app window, replaced or not. */
const PRELOADS = {
  app: "preload/preload.cjs",
  appOrReplaced: "preload/preload.cjs",
  setup: "preload/setup-preload.cjs",
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
  return readdirSync(mainDir, { recursive: true, encoding: "utf8" })
    .filter(
      (file) =>
        file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== path.join("ipc", "ipc.ts"),
    )
    .flatMap((file) =>
      literalChannels(readFileSync(path.join(mainDir, file), "utf8"), /\bhandleIpc\(/, file),
    )
    .sort();
}

/**
 * Signals a preload listens for. The channel map lists calls only, so a signal name is agreed by
 * two files that cannot import each other: the preload that subscribes and the main process that
 * sends. A typo on either side leaves the feature waiting for a message that never arrives.
 */
function preloadSignals() {
  const signals: string[] = [];
  for (const file of new Set(Object.values(PRELOADS))) {
    const source = readFileSync(path.join(srcDir, file), "utf8");
    for (const match of source.matchAll(/\b(?:ipcRenderer\.on|subscribe)\(\s*(["'`])([^"'`]+)\1/g))
      signals.push(match[2] ?? "");
    // A listener given a variable would escape the check, so the only one allowed to take one is
    // the `subscribe` helper's own call.
    const named = (source.match(/\bipcRenderer\.on\(\s*["'`]/g) ?? []).length;
    const all = (source.match(/\bipcRenderer\.on\(/g) ?? []).length;
    expect(
      all - named,
      `${file} must name every listener except its own helper`,
    ).toBeLessThanOrEqual(1);
  }
  return signals;
}

/** Every source file of the main process, where a signal name may be a literal or a constant. */
function mainSource() {
  return readdirSync(mainDir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => readFileSync(path.join(mainDir, file), "utf8"))
    .join("\n");
}

/**
 * Signals the main process actually sends. A send names its channel either directly or through a
 * constant, and only a send counts: the name surviving in a listener or a comment would leave the
 * preload waiting just the same.
 */
function sentSignals() {
  const source = mainSource();
  const constants = new Map<string, string>();
  for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])([^"'`]+)\2/g))
    if (match[1] && match[3]) constants.set(match[1], match[3]);
  const sent = new Set<string>();
  for (const match of source.matchAll(/\.send\(\s*(?:(["'`])([^"'`]+)\1|([A-Za-z_$][\w$]*))/g)) {
    const literal = match[2];
    const identifier = match[3];
    if (literal) sent.add(literal);
    else if (identifier && constants.has(identifier)) sent.add(constants.get(identifier)!);
  }
  return sent;
}

describe("desktop IPC channels", () => {
  it("handles every channel in the map exactly once", () => {
    expect(handledChannels()).toEqual(channels.map(([name]) => name).sort());
  });

  it.each(["preload/preload.cjs", "preload/setup-preload.cjs"] as const)(
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

  it("sends every signal a preload listens for from the main process", () => {
    const signals = [...new Set(preloadSignals())].sort();
    expect(signals.length, "no preload signal was found; update this check").toBeGreaterThan(0);
    const sent = sentSignals();
    expect(
      signals.filter((signal) => !sent.has(signal)),
      "a preload listens for a signal the main process never sends",
    ).toEqual([]);
  });
});
