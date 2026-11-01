import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocaleHandler,
  desktopLocale,
  desktopMessages,
  errorDetail,
  resolveDesktopLocale,
  startDesktopLocale,
  t,
  withDetail,
} from "./i18n.js";
import { ES_MESSAGES } from "./locales/es.js";
import { readUiLocale, writeUiLocale } from "./setup-store.js";

const srcDir = import.meta.dirname;
/** Product and vendor names the setup page shows as they are. */
const UNTRANSLATED = new Set([
  "Rakazo",
  "Rakazo Cloud",
  "Docker Desktop",
  "OrbStack",
  "Docker Engine",
  "https://rakazo.example.com",
]);

/** Literal `t("…")` ids; the formatter keeps every string double-quoted. */
function translationIds(source: string): string[] {
  return [...source.matchAll(/\bt\(\s*("(?:\\.|[^"\\])*")/g)].map(
    (match) => JSON.parse(match[1] ?? '""') as string,
  );
}

/** What setup.js translates in setup.html: its text and its title, aria-label and placeholder attributes. */
function setupPageStrings(): string[] {
  const html = readFileSync(path.join(srcDir, "setup.html"), "utf8");
  const text = [...html.matchAll(/>([^<>]*)</g)].map((match) => match[1]?.trim() ?? "");
  const attributes = [...html.matchAll(/\s(?:title|aria-label|placeholder)="([^"]*)"/g)].map(
    (match) => match[1] ?? "",
  );
  return [...text, ...attributes].filter((value) => value !== "" && !UNTRANSLATED.has(value));
}

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1] ?? "").sort();
}

function appFrame(url = "https://app.example.com/bots") {
  const frame = { url };
  const contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents;
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent;
  return { event, target: { webContents: contents, url: "https://app.example.com" } };
}

afterEach(() => {
  startDesktopLocale(null, "en-US");
});

describe("desktop language", () => {
  it.each([
    ["es", "en-US", "es"],
    ["en", "es-CL", "en"],
    [null, "es-419", "es"],
    [null, "es_ES", "es"],
    // The app offers languages the desktop has no catalog for yet; those read English.
    ["de", "es-CL", "en"],
    [null, "fr-FR", "en"],
    [null, undefined, "en"],
  ] as const)("resolves reported %s on a %s system to %s", (reported, system, expected) => {
    expect(resolveDesktopLocale(reported, system)).toBe(expected);
  });

  it("starts in the saved language, ignoring a saved value that is not a language tag", () => {
    expect(startDesktopLocale("es-MX", "en-US")).toBe("es");
    expect(t("Check for Updates…")).toBe("Buscar actualizaciones…");
    expect(t("Rakazo {version} is ready to install.", { version: "1.2.0" })).toBe(
      "Rakazo 1.2.0 está listo para instalarse.",
    );
    expect(desktopMessages()).toBe(ES_MESSAGES);

    expect(startDesktopLocale("es; rm -rf /", "en-US")).toBe("en");
    expect(t("Check for Updates…")).toBe("Check for Updates…");
    expect(desktopMessages()).toEqual({});
  });

  it("saves a language the app window reports and rebuilds the menus when it changes", async () => {
    startDesktopLocale(null, "en-US");
    const { event, target } = appFrame();
    const save = vi.fn(async () => undefined);
    const onChange = vi.fn();
    const handle = createLocaleHandler(() => target, save, onChange);

    await handle(event, "es");
    expect(desktopLocale()).toBe("es");
    expect(save).toHaveBeenLastCalledWith("es");
    expect(onChange).toHaveBeenCalledTimes(1);

    // Another regional Spanish is still Spanish: saved for the next launch, menus unchanged.
    await handle(event, "es-MX");
    expect(save).toHaveBeenLastCalledWith("es-MX");
    expect(onChange).toHaveBeenCalledTimes(1);

    // Every launch reports again; an unchanged language writes nothing.
    await handle(event, "es-MX");
    expect(save).toHaveBeenCalledTimes(2);

    await handle(event, "de");
    expect(desktopLocale()).toBe("en");
    expect(save).toHaveBeenLastCalledWith("de");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("refuses reports from other windows, subframes, origins and non-tags", async () => {
    startDesktopLocale(null, "en-US");
    const { event, target } = appFrame();
    const save = vi.fn(async () => undefined);
    const onChange = vi.fn();
    const handle = createLocaleHandler(() => target, save, onChange);

    await handle({ ...event, sender: {} as WebContents }, "es");
    await handle(
      { ...event, senderFrame: { url: target.url } as IpcMainInvokeEvent["senderFrame"] },
      "es",
    );
    await handle(appFrame("https://other.example.com").event, "es");
    await createLocaleHandler(() => null, save, onChange)(event, "es");
    for (const value of [3, null, {}, "", "e", "es-", "../es", "es\nde", "x".repeat(36), "es;de"])
      await handle(event, value);

    expect(save).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(desktopLocale()).toBe("en");
  });

  it("keeps error messages English for reports and shows their translated detail", () => {
    startDesktopLocale("es", undefined);
    const error = withDetail(new Error("Page failed to load."), t("Page failed to load."));
    expect(error.message).toBe("Page failed to load.");
    expect(errorDetail(error)).toBe(ES_MESSAGES["Page failed to load."]);
    expect(errorDetail(new Error("plain"))).toBeUndefined();
    expect(errorDetail(null)).toBeUndefined();
  });

  it("keeps the last report when an earlier save finishes later", async () => {
    startDesktopLocale(null, "en-US");
    const { event, target } = appFrame();
    const saved: string[] = [];
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const save = vi.fn(async (locale: string) => {
      if (locale === "es") await firstWrite;
      saved.push(locale);
    });
    const handle = createLocaleHandler(
      () => target,
      save,
      () => undefined,
    );

    const first = handle(event, "es");
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith("es"));
    const second = handle(event, "en");
    releaseFirst();
    await Promise.all([first, second]);

    expect(saved).toEqual(["es", "en"]);
    expect(desktopLocale()).toBe("en");
  });

  it("saves the same language again after a failed save", async () => {
    startDesktopLocale(null, "en-US");
    const { event, target } = appFrame();
    const save = vi
      .fn(async (_locale: string) => undefined)
      .mockRejectedValueOnce(new Error("disk full"));
    const handle = createLocaleHandler(
      () => target,
      save,
      () => undefined,
    );

    await handle(event, "es");
    await handle(event, "es");

    expect(save).toHaveBeenCalledTimes(2);
  });

  it("skips writing a report a later one already replaced", async () => {
    startDesktopLocale(null, "en-US");
    const { event, target } = appFrame();
    const save = vi.fn(async (_locale: string) => undefined);
    const handle = createLocaleHandler(
      () => target,
      save,
      () => undefined,
    );

    await Promise.all(["es", "en", "es", "en"].map((locale) => handle(event, locale)));

    expect(save).not.toHaveBeenCalledWith("es");
    expect(save).toHaveBeenLastCalledWith("en");
  });

  it("opens the next launch in the language the app window last reported", async () => {
    const userData = await mkdtemp(path.join(tmpdir(), "rakazo-locale-"));
    try {
      await expect(readUiLocale(userData)).resolves.toBeNull();
      const { event, target } = appFrame();
      const handle = createLocaleHandler(
        () => target,
        (locale) => writeUiLocale(userData, locale),
        () => undefined,
      );
      startDesktopLocale(await readUiLocale(userData), "en-US");
      await handle(event, "es-AR");

      startDesktopLocale(null, "en-US");
      expect(startDesktopLocale(await readUiLocale(userData), "en-US")).toBe("es");
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });
});

describe("Spanish catalog", () => {
  it("keeps every placeholder and leaves no entry empty", () => {
    const empty = Object.entries(ES_MESSAGES).filter(([, value]) => !value.trim());
    const mismatched = Object.entries(ES_MESSAGES).filter(
      ([id, value]) => JSON.stringify(placeholders(id)) !== JSON.stringify(placeholders(value)),
    );
    expect(empty).toEqual([]);
    expect(mismatched).toEqual([]);
  });

  it("translates every desktop t() id and setup page string, and nothing else", () => {
    const ids = new Set(setupPageStrings());
    for (const file of readdirSync(srcDir)) {
      if (!/\.(ts|js|cjs)$/.test(file) || file.endsWith(".test.ts")) continue;
      for (const id of translationIds(readFileSync(path.join(srcDir, file), "utf8"))) ids.add(id);
    }
    const missing = [...ids].filter((id) => !ES_MESSAGES[id]?.trim()).sort();
    const unused = Object.keys(ES_MESSAGES)
      .filter((id) => !ids.has(id))
      .sort();
    expect(missing).toEqual([]);
    expect(unused).toEqual([]);
  });
});
