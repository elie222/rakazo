import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadManagedVoiceProfiles } from "./managed-voice-profiles.js";

const BOT_ID = `c${"0".repeat(24)}`;
const roots: string[] = [];

async function root() {
  const directory = await mkdtemp(join(tmpdir(), "rakazo-managed-voice-"));
  roots.push(directory);
  return directory;
}

async function save(directory: string, value: unknown) {
  await writeFile(join(directory, "managed-voice-profiles.json"), JSON.stringify(value));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("managed voice profiles", () => {
  it("uses an empty registry when the private file is absent", async () => {
    const registry = await loadManagedVoiceProfiles(await root());

    expect(registry.forBot(BOT_ID)).toBeUndefined();
  });

  it("loads a strict versioned profile by bot id", async () => {
    const directory = await root();
    await save(directory, {
      version: 1,
      profiles: [
        {
          botId: BOT_ID,
          voiceId: "test::voice-1",
          voiceLabel: "Test voice",
          model: "model-1",
          settings: { speed: 0.94, nested: { enabled: true } },
        },
      ],
    });

    const registry = await loadManagedVoiceProfiles(directory);

    expect(registry.forBot(BOT_ID)).toEqual({
      botId: BOT_ID,
      voiceId: "test::voice-1",
      voiceLabel: "Test voice",
      model: "model-1",
      settings: { speed: 0.94, nested: { enabled: true } },
    });
  });

  it("rejects duplicate bot ids", async () => {
    const directory = await root();
    const profile = { botId: BOT_ID, voiceId: "test::voice-1", voiceLabel: "Test voice" };
    await save(directory, { version: 1, profiles: [profile, profile] });

    await expect(loadManagedVoiceProfiles(directory)).rejects.toThrow(
      "managed-voice-profiles.json: duplicate botId",
    );
  });

  it("rejects an unqualified voice id", async () => {
    const directory = await root();
    await save(directory, {
      version: 1,
      profiles: [{ botId: BOT_ID, voiceId: "voice-1", voiceLabel: "Test voice" }],
    });

    await expect(loadManagedVoiceProfiles(directory)).rejects.toThrow(
      "managed-voice-profiles.json",
    );
  });

  it("rejects unknown fields", async () => {
    const directory = await root();
    await save(directory, {
      version: 1,
      profiles: [
        { botId: BOT_ID, voiceId: "test::voice-1", voiceLabel: "Test voice", secret: "no" },
      ],
    });

    await expect(loadManagedVoiceProfiles(directory)).rejects.toThrow(
      "managed-voice-profiles.json",
    );
  });

  it("rejects a model that cannot be sent as a provider model id", async () => {
    const directory = await root();
    await save(directory, {
      version: 1,
      profiles: [
        {
          botId: BOT_ID,
          voiceId: "test::voice-1",
          voiceLabel: "Test voice",
          model: "bad model",
        },
      ],
    });

    await expect(loadManagedVoiceProfiles(directory)).rejects.toThrow(
      "managed-voice-profiles.json",
    );
  });

  it("reports invalid JSON with the private file name", async () => {
    const directory = await root();
    await writeFile(join(directory, "managed-voice-profiles.json"), "{");

    await expect(loadManagedVoiceProfiles(directory)).rejects.toThrow(
      "managed-voice-profiles.json",
    );
  });
});
