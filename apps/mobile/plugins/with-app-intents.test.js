import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
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

describe("withAppIntents prebuild", () => {
  it("refreshes the source without duplicating its build reference", () => {
    const files = new Set();
    const copied = [];
    const added = [];
    const config = {
      modRequest: { projectRoot: "/project", platformProjectRoot: "/project/ios" },
      modResults: { hasFile: (file) => files.has(file) },
    };
    const plist = { modResults: {} };
    const module = { exports: {} };
    runInNewContext(read("plugins/with-app-intents.js"), {
      module,
      __dirname: join(mobile, "plugins"),
      process: { env: { EXPO_PUBLIC_API_URL: "https://api.example.test" } },
      require: (name) => {
        if (name === "node:fs") return { copyFileSync: (...args) => copied.push(args) };
        if (name === "node:path") return { join, basename: () => "RakazoIntents.swift" };
        if (name === "expo/config-plugins")
          return {
            withInfoPlist: (value, mod) => {
              mod(plist);
              return value;
            },
            withXcodeProject: (value, mod) => mod(value),
            IOSConfig: {
              XcodeUtils: {
                getProjectName: () => "Rakazo",
                addBuildSourceFileToGroup: (input) => {
                  added.push(input);
                  files.add(input.filepath);
                },
              },
            },
          };
        throw new Error(`Unexpected module: ${name}`);
      },
    });
    module.exports(config);
    module.exports(config);
    expect(plist.modResults.RakazoDefaultApiBase).toBe("https://api.example.test");
    expect(copied).toEqual([
      [join(mobile, "ios-intents/RakazoIntents.swift"), "/project/ios/Rakazo/RakazoIntents.swift"],
      [join(mobile, "ios-intents/RakazoIntents.swift"), "/project/ios/Rakazo/RakazoIntents.swift"],
    ]);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ filepath: "Rakazo/RakazoIntents.swift", groupName: "Rakazo" });
  });
});
