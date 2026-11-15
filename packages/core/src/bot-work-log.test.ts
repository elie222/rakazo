import type { BotWorkLogEntry } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { workLogRow } from "./bot-work-log.js";

const entry = (tool: string, action?: Partial<NonNullable<BotWorkLogEntry["action"]>>) =>
  ({
    id: "1",
    createdAt: "2026-11-15T10:00:00.000Z",
    runId: "run-1",
    tool,
    ...(action
      ? {
          action: {
            executionId: "e",
            kind: "shell",
            command: "ls",
            cwd: "/work",
            status: "done",
            exitCode: 0,
            output: "",
            ...action,
          },
        }
      : {}),
  }) satisfies BotWorkLogEntry;

it("names a row by its command or path, falling back to the tool", () => {
  expect(workLogRow(entry("shell", { command: "pnpm test" })).title).toBe("pnpm test");
  expect(workLogRow(entry("web_search")).title).toBe("web_search");
});

it("shows a written file's size and only a failed command's exit code", () => {
  expect(workLogRow(entry("write_file", { kind: "write_file", bytes: 2048 })).size).toBe("2 KB");
  expect(workLogRow(entry("shell", { bytes: 5 })).size).toBeNull();
  expect(workLogRow(entry("shell", { exitCode: 2 })).exitCode).toBe(2);
  expect(workLogRow(entry("shell", { exitCode: 0 })).exitCode).toBeNull();
  expect(workLogRow(entry("shell", { exitCode: null })).exitCode).toBeNull();
});

it("marks a command that has not finished", () => {
  expect(workLogRow(entry("shell", { status: "running", exitCode: null })).running).toBe(true);
  expect(workLogRow(entry("shell", { status: "done" })).running).toBe(false);
  expect(workLogRow(entry("web_search")).running).toBe(false);
});
