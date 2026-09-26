import type { ComputerCommand, ProductEvent } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  formatComputerCommand,
  formatSize,
  mergeComputerCommand,
  parentPath,
  publishComputerCommand,
  sortEntries,
  subscribeComputerCommands,
} from "./computer-workspace";

const command = (overrides: Partial<ComputerCommand> = {}): ComputerCommand => ({
  executionId: "call-1",
  kind: "shell",
  command: "ls",
  cwd: "bots/bot-1",
  status: "done",
  exitCode: 0,
  output: "a\nb\n",
  ...overrides,
});

const labels = {
  write_file: (path: string) => `Wrote ${path}`,
  attach_file: (path: string) => `Attached ${path}`,
  open_path: (path: string) => `Opened ${path}`,
  launch_app: (app: string) => `Launched ${app}`,
};

describe("computer terminal feed", () => {
  it("renders a prompt line, output, and only failing exit codes", () => {
    expect(formatComputerCommand(command(), labels)).toBe("\x1b[1m$ ls\x1b[0m\r\na\r\nb\r\n");
    expect(formatComputerCommand(command({ exitCode: 2, output: "" }), labels)).toBe(
      "\x1b[1m$ ls\x1b[0m\r\n\x1b[2m[exit 2]\x1b[0m\r\n",
    );
  });

  it("renders file and app actions as one described line, with the error if they failed", () => {
    const wrote = command({ kind: "write_file", command: "notes.txt", output: "", bytes: 2048 });
    expect(formatComputerCommand(wrote, labels)).toBe(
      "\x1b[2m✎\x1b[0m Wrote notes.txt \x1b[2m(2.0 KB)\x1b[0m\r\n",
    );
    const failed = command({
      kind: "attach_file",
      command: "missing.pdf",
      exitCode: 1,
      output: "file not found or unreadable",
    });
    expect(formatComputerCommand(failed, labels)).toBe(
      "\x1b[2m✎\x1b[0m Attached missing.pdf\r\n\x1b[2mfile not found or unreadable\x1b[0m\r\n",
    );
    expect(
      formatComputerCommand(
        command({ kind: "launch_app", command: "firefox", output: "" }),
        labels,
      ),
    ).toBe("\x1b[2m↗\x1b[0m Launched firefox\r\n");
  });

  it("replaces a running command with its result in place", () => {
    const started = [
      command({ status: "running", exitCode: null, output: "" }),
      command({ executionId: "call-2" }),
    ];
    expect(mergeComputerCommand(started, command()).map((entry) => entry.status)).toEqual([
      "done",
      "done",
    ]);
  });

  it("forwards only valid command events to subscribers", () => {
    const received: Array<[string, ComputerCommand]> = [];
    const unsubscribe = subscribeComputerCommands((botId, entry) => received.push([botId, entry]));
    const event = (type: string, payload: Record<string, unknown>) =>
      ({ type, botId: "bot-1", payload }) as unknown as ProductEvent;
    publishComputerCommand(event("computer.command", command()));
    publishComputerCommand(event("computer.command", { command: "ls" }));
    publishComputerCommand(event("agent.tool.called", command()));
    unsubscribe();
    publishComputerCommand(event("computer.command", command()));
    expect(received).toEqual([["bot-1", command()]]);
  });
});

describe("computer files", () => {
  it("lists folders first, then names alphabetically", () => {
    expect(
      sortEntries([
        { path: "notes/b.txt", kind: "file", size: 1 },
        { path: "notes/z", kind: "dir", size: 0 },
        { path: "notes/a.txt", kind: "file", size: 1 },
      ]).map((entry) => entry.path),
    ).toEqual(["notes/z", "notes/a.txt", "notes/b.txt"]);
  });

  it("navigates up to the bot home", () => {
    expect(parentPath("notes/drafts")).toBe("notes");
    expect(parentPath("notes")).toBe("");
  });

  it("formats sizes compactly", () => {
    expect([formatSize(512), formatSize(2048), formatSize(3 * 1024 * 1024)]).toEqual([
      "512 B",
      "2.0 KB",
      "3.0 MB",
    ]);
  });
});
