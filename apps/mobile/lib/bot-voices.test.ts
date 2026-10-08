import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());
const voices = vi.hoisted(() => ({
  list: [] as Array<{
    identifier: string;
    language: string;
    name?: string;
    quality?: string;
    localService?: boolean;
    requiresNetwork?: boolean;
  }>,
}));

const device = vi.hoisted(() => ({
  platform: "ios",
  locale: "en-US",
  regionCode: null as string | null,
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return device.platform;
    },
  },
}));
vi.mock("expo-localization", () => ({
  getLocales: () => [{ languageTag: device.locale, regionCode: device.regionCode }],
}));

const ASSIGNMENTS = "doc/rakazo-bot-voices.json";

vi.mock("expo-file-system", () => ({
  Paths: { document: "doc" },
  File: class {
    private readonly key: string;
    constructor(dir: string, name: string) {
      this.key = `${dir}/${name}`;
    }
    get exists() {
      return files.has(this.key);
    }
    create() {
      files.set(this.key, "");
    }
    async text() {
      // Snapshot before yielding. Two callers that are actually in this read at once
      // both see the same map; a later write cannot sneak into an in-flight read.
      const content = files.get(this.key) ?? "";
      await new Promise((resolve) => setTimeout(resolve, 20));
      return content;
    }
    write(content: string) {
      files.set(this.key, content);
    }
  },
}));
vi.mock("expo-speech", () => ({ getAvailableVoicesAsync: async () => voices.list }));
vi.mock("./i18n", () => ({ getActiveUiLocale: () => "en" }));

const { deviceVoices, setVoiceForBot, voiceForBot } = await import("./bot-voices");

beforeEach(() => {
  files.clear();
  voices.list = [];
  device.platform = "ios";
  device.locale = "en-US";
  device.regionCode = null;
});

describe("deviceVoices", () => {
  it("only offers explicitly local Android voices", async () => {
    device.platform = "android";
    voices.list = [
      { identifier: "en-US-language", language: "en-US" },
      { identifier: "en-us-x-iob-network", language: "en-US" },
      { identifier: "en-us-x-iob-local", language: "en-US" },
      { identifier: "remote-local", language: "en-US", localService: false },
      { identifier: "requires-local", language: "en-US", requiresNetwork: true },
      { identifier: "network-local", language: "en-US" },
      { identifier: "named-local", name: "Network voice", language: "en-US" },
    ];
    expect((await deviceVoices()).map((voice) => voice.identifier)).toEqual(["en-us-x-iob-local"]);
  });

  it("excludes novelty names and identifiers from the picker", async () => {
    voices.list = ["Bubbles", "Zarvox", "Bad News", "Bells", "Albert", "Junior", "Ralph"].map(
      (name) => ({ identifier: `com.apple.voice.${name}`, language: "en-US" }),
    );
    expect(await deviceVoices()).toEqual([]);
  });

  it("uses the device language even when the UI language differs", async () => {
    device.locale = "de-DE";
    voices.list = [
      { identifier: "english", language: "en-US" },
      { identifier: "german", language: "de-DE" },
    ];
    expect((await deviceVoices()).map((voice) => voice.identifier)).toEqual(["german"]);
    expect(await voiceForBot("bot-a")).toBe("german");
  });

  it("offers neither a network voice nor a voice for another language", async () => {
    voices.list = [
      { identifier: "en-us-x-iob-network", language: "en-US" },
      { identifier: "de-de-x-deb-local", language: "de-DE" },
    ];
    expect(await deviceVoices()).toEqual([]);
  });

  it("offers nothing when every voice is a network voice", async () => {
    voices.list = [{ identifier: "en-us-x-iob-network", language: "en-US" }];
    expect(await deviceVoices()).toEqual([]);
  });

  it("drops a voice that requires a network connection even when its id does not say so", async () => {
    voices.list = [
      { identifier: "en-US-language", name: "English", language: "en-US", requiresNetwork: true },
      { identifier: "en-us-x-iob-local", name: "iob", language: "en-US" },
    ];
    expect((await deviceVoices()).map((voice) => voice.identifier)).toEqual(["en-us-x-iob-local"]);
  });

  it("drops a remote web voice and keeps the on-device one", async () => {
    voices.list = [
      {
        identifier: "Google US English",
        name: "Google US English",
        language: "en-US",
        localService: false,
      },
      { identifier: "Samantha", name: "Samantha", language: "en-US", localService: true },
    ];
    expect((await deviceVoices()).map((voice) => voice.identifier)).toEqual(["Samantha"]);
  });
});

describe("voiceForBot", () => {
  it.each(["en-IL", "en"])(
    "falls back from %s to US English and shares within that tier",
    async (locale) => {
      device.locale = locale;
      device.regionCode = "IL";
      voices.list = [
        { identifier: "fred", language: "en-US" },
        { identifier: "kathy", language: "en-US" },
        { identifier: "samantha", language: "en-US" },
        { identifier: "karen", language: "en-AU" },
        { identifier: "daniel", language: "en-GB" },
        { identifier: "moira", language: "en-IE" },
        { identifier: "rishi", language: "en-IN" },
        { identifier: "tessa", language: "en-ZA", quality: "Enhanced" },
      ];
      const assigned = [];
      for (const botId of ["bot-a", "bot-b", "bot-c", "bot-d"]) {
        const voice = await voiceForBot(botId);
        expect(["fred", "kathy", "samantha"]).toContain(voice);
        assigned.push(voice);
      }
      expect(new Set(assigned.slice(0, 3)).size).toBe(3);
      expect(await deviceVoices()).toHaveLength(8);
    },
  );

  it.each([
    { locale: "EN-gb", region: null },
    { locale: "en", region: "gb" },
  ])(
    "matches the device locale or region case-insensitively ($locale, $region)",
    async ({ locale, region }) => {
      device.locale = locale;
      device.regionCode = region;
      voices.list = [
        { identifier: "us", language: "en-US" },
        { identifier: "gb", language: "en-GB" },
      ];
      expect(await voiceForBot("bot-a")).toBe("gb");
      expect(await voiceForBot("bot-b")).toBe("gb");
    },
  );

  it.each([
    ["de-AT", "de-DE"],
    ["ru-KZ", "ru-RU"],
    ["zh-SG", "zh-CN"],
    ["fr-CA", "fr-FR"],
    ["es-MX", "es-ES"],
    ["ja", "ja-JP"],
  ])("uses the primary region for %s", async (locale, primary) => {
    device.locale = locale;
    voices.list = [
      { identifier: "other", language: `${locale.split("-")[0]}-ZZ`, quality: "Enhanced" },
      { identifier: "primary", language: primary },
    ];
    expect(await voiceForBot("bot-a")).toBe("primary");
  });

  it("skips the primary-region tier for an unmapped language", async () => {
    device.locale = "pt-AO";
    voices.list = [{ identifier: "brazil", language: "pt-BR" }];
    expect(await voiceForBot("bot-a")).toBe("brazil");
  });

  it("prefers the full device locale over a different accent and higher quality", async () => {
    device.locale = "en-GB";
    voices.list = [
      { identifier: "us", language: "en-US", quality: "Enhanced" },
      { identifier: "gb", language: "en-GB", quality: "Default" },
    ];
    expect(await voiceForBot("bot-a")).toBe("gb");
    expect(await voiceForBot("bot-b")).toBe("gb");
    expect(await deviceVoices()).toHaveLength(2);
  });

  it("falls back to another region of the same language", async () => {
    device.locale = "en-AU";
    voices.list = [{ identifier: "gb", language: "en-GB" }];
    expect(await voiceForBot("bot-a")).toBe("gb");
  });

  it.each(["Enhanced", "Premium"])(
    "prefers %s quality but preserves unused voices",
    async (quality) => {
      voices.list = [
        { identifier: "default", language: "en-US", quality: "Default" },
        { identifier: "better", language: "en-US", quality },
      ];
      expect(await voiceForBot("bot-a")).toBe("better");
      expect(await voiceForBot("bot-b")).toBe("default");
      expect(await voiceForBot("bot-c")).toBe("better");
    },
  );

  it("keeps a saved normal voice even if its region or quality differs", async () => {
    voices.list = [
      { identifier: "gb", language: "en-GB", quality: "Default" },
      { identifier: "us", language: "en-US", quality: "Enhanced" },
    ];
    await setVoiceForBot("bot-a", "gb");
    expect(await voiceForBot("bot-a")).toBe("gb");
  });

  it("gives bots asking at the same time different voices and keeps both", async () => {
    voices.list = [
      { identifier: "en-us-x-iob-local", language: "en-US" },
      { identifier: "en-us-x-iog-local", language: "en-US" },
      { identifier: "en-us-x-iol-local", language: "en-US" },
    ];
    // Load the speech module once so the overlap is the assignment read, not the import.
    await deviceVoices();
    // The file has to exist so both reads await it. An empty start returns before any
    // await, and the two calls never overlap.
    files.set(ASSIGNMENTS, JSON.stringify({ "bot-seed": "en-us-x-iob-local" }));
    const [first, second] = await Promise.all([voiceForBot("bot-a"), voiceForBot("bot-b")]);
    const saved = JSON.parse(files.get(ASSIGNMENTS) ?? "{}") as Record<string, string>;
    expect(first).not.toBe(second);
    expect([first, second]).not.toContain("en-us-x-iob-local");
    expect(saved["bot-seed"]).toBe("en-us-x-iob-local");
    expect(saved["bot-a"]).toBe(first);
    expect(saved["bot-b"]).toBe(second);
    expect(new Set(Object.values(saved)).size).toBe(3);
  });

  it("does not auto-assign iOS novelty voices such as Bubbles or Zarvox", async () => {
    voices.list = [
      {
        identifier: "com.apple.speech.synthesis.voice.Bubbles",
        name: "Bubbles",
        language: "en-US",
      },
      {
        identifier: "com.apple.speech.synthesis.voice.Zarvox",
        name: "Zarvox",
        language: "en-US",
      },
      { identifier: "com.apple.voice.compact.en-US.Samantha", name: "Samantha", language: "en-US" },
    ];
    expect(await voiceForBot("bot-a")).toBe("com.apple.voice.compact.en-US.Samantha");
    expect(await voiceForBot("bot-b")).toBe("com.apple.voice.compact.en-US.Samantha");
    expect((await deviceVoices()).map((voice) => voice.name)).toEqual(["Samantha"]);
  });

  it("leaves the choice unset when the only offline voices are novelty voices", async () => {
    voices.list = [
      {
        identifier: "com.apple.speech.synthesis.voice.Bubbles",
        name: "Bubbles",
        language: "en-US",
      },
      {
        identifier: "com.apple.speech.synthesis.voice.Zarvox",
        name: "Zarvox",
        language: "en-US",
      },
    ];
    expect(await voiceForBot("bot-a")).toBeUndefined();
    expect(files.has(ASSIGNMENTS)).toBe(false);
  });

  it("replaces a saved novelty voice with a normal voice", async () => {
    const bubbles = "com.apple.speech.synthesis.voice.Bubbles";
    voices.list = [
      { identifier: bubbles, name: "Bubbles", language: "en-US" },
      { identifier: "com.apple.voice.compact.en-US.Samantha", name: "Samantha", language: "en-US" },
    ];
    await setVoiceForBot("bot-a", bubbles);
    expect(await voiceForBot("bot-a")).toBe("com.apple.voice.compact.en-US.Samantha");
  });
});
