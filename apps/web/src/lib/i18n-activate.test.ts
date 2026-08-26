import { beforeEach, describe, expect, it, vi } from "vitest";
import { activateUiLocale, getActiveUiLocale, i18n, setCatalogLoadersForTests } from "./i18n";

vi.mock("./apply-ui-direction", () => ({
  applyUiDirection: vi.fn(),
}));

describe("activateUiLocale", () => {
  beforeEach(() => {
    setCatalogLoadersForTests(null);
    i18n.load("en", {});
    i18n.activate("en");
  });

  it("falls back to English when the preferred catalog fails to load", async () => {
    setCatalogLoadersForTests({
      en: async () => ({ messages: { Settings: "Settings" } }),
      de: async () => {
        throw new Error("de catalog missing");
      },
      ko: async () => ({ messages: { Settings: "설정" } }),
    });

    const locale = await activateUiLocale("de");
    expect(locale).toBe("en");
    expect(getActiveUiLocale()).toBe("en");
    expect(i18n.locale).toBe("en");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Settings");
  });

  it("falls back to empty English when every catalog fails", async () => {
    setCatalogLoadersForTests({
      en: async () => {
        throw new Error("en missing");
      },
      de: async () => {
        throw new Error("de missing");
      },
      ko: async () => {
        throw new Error("ko missing");
      },
    });

    const locale = await activateUiLocale("ko");
    expect(locale).toBe("en");
    expect(i18n.locale).toBe("en");
  });

  it("lets the latest locale selection win under concurrency", async () => {
    let resolveDe!: (value: { messages: Record<string, string> }) => void;
    const dePromise = new Promise<{ messages: Record<string, string> }>((resolve) => {
      resolveDe = resolve;
    });

    setCatalogLoadersForTests({
      en: async () => ({ messages: { Settings: "Settings" } }),
      de: async () => dePromise,
      ko: async () => ({ messages: { Settings: "설정" } }),
    });

    const first = activateUiLocale("de");
    const second = activateUiLocale("ko");
    resolveDe({ messages: { Settings: "Einstellungen" } });

    await expect(first).resolves.toBe("ko");
    await expect(second).resolves.toBe("ko");
    expect(getActiveUiLocale()).toBe("ko");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("설정");
  });
});
