import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());
const voices = vi.hoisted(() => ({ list: [] as Array<{ identifier: string; language: string }> }));

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
      return files.get(this.key) ?? "";
    }
    write(content: string) {
      files.set(this.key, content);
    }
  },
}));
vi.mock("expo-speech", () => ({ getAvailableVoicesAsync: async () => voices.list }));
vi.mock("./i18n", () => ({ getActiveUiLocale: () => "en" }));

const { deviceVoices, voiceForBot } = await import("./bot-voices");

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
});

describe("voiceForBot", () => {
  it("gives bots asking at the same time different voices and keeps both", async () => {
    voices.list = [
      { identifier: "en-us-x-iob-local", language: "en-US" },
      { identifier: "en-us-x-iog-local", language: "en-US" },
    ];
    const [first, second] = await Promise.all([voiceForBot("bot-a"), voiceForBot("bot-b")]);
    expect(first).not.toBe(second);
    expect(await voiceForBot("bot-a")).toBe(first);
    expect(await voiceForBot("bot-b")).toBe(second);
  });
});
