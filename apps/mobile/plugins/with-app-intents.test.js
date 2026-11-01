import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mobile = join(import.meta.dirname, "..");
const read = (file) => readFileSync(join(mobile, file), "utf8");
const constant = (file, name) => read(file).match(new RegExp(`${name} = "([^"]+)"`))?.[1];

describe("RakazoIntents", () => {
  // The intents read what the app saved; renaming a key on one side would break them silently.
  it("reads the secure-store keys the app writes", () => {
    const swift = read("ios-intents/RakazoIntents.swift");
    for (const [file, name] of [
      ["lib/session.ts", "SESSION_KEY"],
      ["lib/server-config.ts", "API_BASE_STORAGE_KEY"],
      ["lib/api.ts", "SPACE_KEY"],
      ["lib/last-bot.ts", "LAST_BOT_KEY"],
      ["lib/last-bot.ts", "LAST_BOT_SPACE_KEY"],
      ["lib/server-headers.ts", "SERVER_HEADERS_KEY"],
    ]) {
      const key = constant(file, name);
      expect(key, `${name} in ${file}`).toBeTruthy();
      expect(swift).toContain(`secureStoreItem("${key}")`);
    }
  });

  it("hands a voice chat to the module that reads it", () => {
    const swift = read("ios-intents/RakazoIntents.swift");
    const module = read("modules/rakazo-voice-chat/ios/RakazoVoiceChatModule.swift");
    expect(swift).toContain('"rakazo.pending_voice_chat"');
    expect(module).toContain('"rakazo.pending_voice_chat"');
    for (const source of [swift, module]) {
      expect(source).toContain('Notification.Name("RakazoPendingVoiceChat")');
    }
  });

  it("falls back to the app's own default server", () => {
    const local = constant("lib/server-config.ts", "LOCAL_API");
    expect(read("plugins/with-app-intents.js")).toContain(`"${local}"`);
  });
});
