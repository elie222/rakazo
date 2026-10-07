import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());
const voices = vi.hoisted(() => ({
  list: [] as Array<{
    identifier: string;
    language: string;
    name?: string;
    localService?: boolean;
    requiresNetwork?: boolean;
  }>,
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
});

describe("deviceVoices", () => {
  it("never offers a network voice, even when the app language has nothing else", async () => {
    voices.list = [
      { identifier: "en-us-x-iob-network", language: "en-US" },
      { identifier: "de-de-x-deb-local", language: "de-DE" },
    ];
    expect((await deviceVoices()).map((voice) => voice.identifier)).toEqual(["de-de-x-deb-local"]);
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
    expect((await deviceVoices()).map((voice) => voice.name)).toEqual([
      "Bubbles",
      "Zarvox",
      "Samantha",
    ]);
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

  it("keeps a novelty voice someone picked on purpose", async () => {
    const bubbles = "com.apple.speech.synthesis.voice.Bubbles";
    voices.list = [
      { identifier: bubbles, name: "Bubbles", language: "en-US" },
      { identifier: "com.apple.voice.compact.en-US.Samantha", name: "Samantha", language: "en-US" },
    ];
    await setVoiceForBot("bot-a", bubbles);
    expect(await voiceForBot("bot-a")).toBe(bubbles);
  });
});
