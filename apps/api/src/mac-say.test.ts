import { describe, expect, it, vi } from "vitest";
import {
  MacSaySpeaker,
  macSayAvailable,
  macVoiceInstalled,
  macVoicePreview,
  parseMacVoices,
  resolveMacVoiceName,
  sanitizeSayText,
} from "./mac-say.js";

const LIST = `Voice 1             en_US    # Hi
Zoe (Premium)       en_US    # Hello! My name is Zoe.
Karen               en_AU    # Hello! My name is Karen.
Daniel (English (UK)) en_GB    # Hello! My name is Daniel.
Flo (Enhanced)      en_US    # Hello! My name is Flo.
`;

describe("parseMacVoices", () => {
  it("lists premium, then enhanced, then the rest", () => {
    expect(parseMacVoices(LIST).map((voice) => voice.name)).toEqual([
      "Zoe (Premium)",
      "Flo (Enhanced)",
      "Daniel (English (UK))",
      "Karen",
      "Voice 1",
    ]);
  });

  it("keeps a locale and only treats a trailing quality mark as quality", () => {
    const voices = parseMacVoices(LIST);
    expect(voices.find((voice) => voice.name.startsWith("Daniel"))?.quality).toBe("standard");
    expect(voices.find((voice) => voice.name.startsWith("Zoe"))?.quality).toBe("premium");
  });
});

describe("macVoiceInstalled", () => {
  const voices = parseMacVoices(LIST);

  it("matches the listed name, the prefix, and the bare downloaded name", () => {
    expect(macVoiceInstalled("macos:Zoe (Premium)", voices)).toBe(true);
    expect(macVoiceInstalled("Zoe", voices)).toBe(true);
    expect(macVoiceInstalled("Missing", voices)).toBe(false);
  });
});

describe("macVoicePreview", () => {
  it("drops the quality or locale suffix from the spoken name", () => {
    expect(macVoicePreview("Zoe (Premium)")).toBe("Hi, I'm Zoe.");
    expect(macVoicePreview("Daniel (English (UK))")).toBe("Hi, I'm Daniel.");
  });
});

describe("macSayAvailable", () => {
  it("requires Darwin and an executable say binary", () => {
    expect(macSayAvailable("linux")).toBe(false);
    expect(macSayAvailable("darwin", "/no/such/say")).toBe(false);
  });
});

describe("resolveMacVoiceName", () => {
  it("returns the installed name for a prefix or a bare downloaded name", () => {
    const voices = parseMacVoices(LIST);
    expect(resolveMacVoiceName("macos:Zoe (Premium)", voices)).toBe("Zoe (Premium)");
    expect(resolveMacVoiceName("Zoe", voices)).toBe("Zoe (Premium)");
    expect(resolveMacVoiceName("Missing", voices)).toBeNull();
  });
});

describe("MacSaySpeaker", () => {
  it("rejects an unknown voice and speaks a bare name as the installed voice", async () => {
    const say = vi.fn(async () => undefined);
    const speaker = new MacSaySpeaker(async () => parseMacVoices(LIST), say);
    await expect(speaker.enqueue("Missing", "Hello")).rejects.toThrow(/not installed/);
    await expect(speaker.enqueue("Zoe", "Hello")).resolves.toBeUndefined();
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith("Zoe (Premium)", "Hello");
  });

  it("speaks one utterance at a time and strips control characters", async () => {
    const started: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const say = vi.fn(async (voice: string) => {
      started.push(voice);
      if (started.length === 1) await first;
    });
    const speaker = new MacSaySpeaker(async () => parseMacVoices(LIST), say);
    const one = speaker.enqueue("Zoe (Premium)", "Hello\u0000 there");
    const two = speaker.enqueue("Karen", "Next");
    await vi.waitFor(() => expect(started).toEqual(["Zoe (Premium)"]));
    releaseFirst();
    await Promise.all([one, two]);
    expect(started).toEqual(["Zoe (Premium)", "Karen"]);
    expect(say).toHaveBeenNthCalledWith(1, "Zoe (Premium)", "Hello there");
  });
});

describe("sanitizeSayText", () => {
  it("caps a long utterance", () => {
    expect(sanitizeSayText("a".repeat(5_000))).toHaveLength(4_000);
  });
});
