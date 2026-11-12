import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_TOOLS_ENV, coreBuiltinToolNames, loadCoreToolNames } from "./core-tools.js";

/** The list every healthy source must yield: the shipped default plus the bridge tools. */
const EXPECTED_DEFAULT_NAMES = [
  "ask_user",
  "attach_file",
  "browser_act",
  "browser_navigate",
  "browser_snapshot",
  "computer_act",
  "computer_observe",
  "connect_app",
  "create_page",
  "end_call",
  "find_tool",
  "list_files",
  "message_user",
  "read_email",
  "read_file",
  "read_history",
  "recall_memory",
  "remember",
  "request_secret",
  "request_takeover",
  "run_subagent",
  "save_memory",
  "schedule_create",
  "schedule_list",
  "search_history",
  "send_email",
  "service_call",
  "service_search",
  "shell",
  "skill_read",
  "update_bot",
  "update_preferences",
  "use_tool",
  "user_computer_shell",
  "web_fetch",
  "web_search",
  "write_file",
];

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

function writeJson(name: string, raw: string): string {
  if (!tempDir) tempDir = mkdtempSync(path.join(tmpdir(), "core-tools-"));
  const file = path.join(tempDir, name);
  writeFileSync(file, raw);
  return file;
}

function installTestLogger() {
  const sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  return sink;
}

describe("core tools", () => {
  it("loads the shipped default when no override is set", () => {
    const sink = installTestLogger();
    const loaded = loadCoreToolNames({});
    expect(loaded.source).toBe("default");
    expect([...loaded.names].sort()).toEqual(EXPECTED_DEFAULT_NAMES);
    const line = sink.events.find((event) => event.message === "core tools loaded");
    expect(line).toBeDefined();
    expect(line?.["core.tools.source"]).toBe("default");
    expect(line?.["core.tools.count"]).toBe(EXPECTED_DEFAULT_NAMES.length);
    expect(line?.["core.tools.names"]).toContain("read_email");
  });

  it("treats a blank override as unset", () => {
    const loaded = loadCoreToolNames({ [CORE_TOOLS_ENV]: "   " });
    expect(loaded.source).toBe("default");
    expect(loaded.names.has("read_email")).toBe(true);
  });

  it("lets an override file replace the default", () => {
    const sink = installTestLogger();
    const file = writeJson("core-tools.json", JSON.stringify({ core: ["shell", "web_search"] }));
    const loaded = loadCoreToolNames({ [CORE_TOOLS_ENV]: file });
    expect(loaded.source).toBe("override");
    expect(loaded.file).toBe(file);
    expect([...loaded.names].sort()).toEqual(["find_tool", "shell", "use_tool", "web_search"]);
    expect(
      sink.events.find((event) => event.message === "core tools loaded")?.["core.tools.file"],
    ).toBe(file);
  });

  it("keeps find_tool and use_tool listed when a file omits them", () => {
    const sink = installTestLogger();
    const file = writeJson("core-tools.json", JSON.stringify({ core: ["shell"] }));
    const loaded = loadCoreToolNames({ [CORE_TOOLS_ENV]: file });
    expect(loaded.names.has("find_tool")).toBe(true);
    expect(loaded.names.has("use_tool")).toBe(true);
    const line = sink.events.find((event) => event.message === "core tools loaded");
    expect(line?.["core.tools.warnings"]).toEqual(
      expect.arrayContaining(["added protected tool find_tool", "added protected tool use_tool"]),
    );
  });

  it("skips unknown names with a warning instead of crashing", () => {
    const sink = installTestLogger();
    const file = writeJson(
      "core-tools.json",
      JSON.stringify({ core: ["shell", "not_a_tool", "", "   "] }),
    );
    const loaded = loadCoreToolNames({ [CORE_TOOLS_ENV]: file });
    expect([...loaded.names].sort()).toEqual(["find_tool", "shell", "use_tool"]);
    const line = sink.events.find((event) => event.message === "core tools loaded");
    expect(line?.["core.tools.warnings"]).toEqual(
      expect.arrayContaining(["skipped unknown core tool not_a_tool"]),
    );
  });

  it("falls back to the built-in list when the override is not valid JSON", () => {
    const sink = installTestLogger();
    const file = writeJson("core-tools.json", "this is not json");
    const loaded = loadCoreToolNames({ [CORE_TOOLS_ENV]: file });
    expect(loaded.source).toBe("fallback");
    expect(loaded.file).toBe(file);
    expect([...loaded.names].sort()).toEqual(EXPECTED_DEFAULT_NAMES);
    const error = sink.events.find((event) => event.level === "error");
    expect(error).toBeDefined();
    expect(error?.message).toContain("built-in list");
    expect(
      sink.events.find((event) => event.message === "core tools loaded")?.["core.tools.source"],
    ).toBe("fallback");
  });

  it("falls back to the built-in list when the override is unreadable", () => {
    const sink = installTestLogger();
    const missing = path.join(tmpdir(), `core-tools-missing-${Date.now()}.json`);
    const loaded = loadCoreToolNames({ [CORE_TOOLS_ENV]: missing });
    expect(loaded.source).toBe("fallback");
    expect(loaded.names.has("shell")).toBe(true);
    expect(sink.events.some((event) => event.level === "error")).toBe(true);
  });

  it("falls back to the built-in list when the file has the wrong shape", () => {
    const sink = installTestLogger();
    const file = writeJson("core-tools.json", JSON.stringify({ core: "shell" }));
    const loaded = loadCoreToolNames({ [CORE_TOOLS_ENV]: file });
    expect(loaded.source).toBe("fallback");
    expect(sink.events.some((event) => event.level === "error")).toBe(true);
  });

  it("loads once per process", () => {
    const sink = installTestLogger();
    const first = coreBuiltinToolNames();
    const second = coreBuiltinToolNames();
    expect(second).toBe(first);
    expect(sink.events.filter((event) => event.message === "core tools loaded")).toHaveLength(1);
  });
});
