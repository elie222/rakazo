import type { ComputerCommand, ProductEvent } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  applyComputerCommandHistory,
  COMPUTER_COMMAND_FEED_LIMIT,
  formatComputerCommand,
  formatComputerCommandFeed,
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
  it("strips control sequences from command text and output before rendering", () => {
    expect(
      formatComputerCommand(
        command({ command: "echo \u001b[2Jhi", output: "ok\u001b]8;;https://evil\u0007\n" }),
        labels,
      ),
    ).toBe("\x1b[1m$ echo [2Jhi\x1b[0m\r\nok]8;;https://evil\r\n");
  });

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

  it("renders a dim placeholder instead of a blank terminal when the feed is empty", () => {
    expect(formatComputerCommandFeed([], labels, "No bot activity yet.")).toBe(
      "\x1b[2mNo bot activity yet.\x1b[0m\r\n",
    );
    expect(formatComputerCommandFeed([command()], labels, "No bot activity yet.")).toBe(
      "\x1b[1m$ ls\x1b[0m\r\na\r\nb\r\n",
    );
  });

  it("keeps the history page and live commands that are not in it yet", () => {
    const history = [command({ executionId: "call-2" }), command({ executionId: "call-3" })];
    const pending = [
      command({ executionId: "call-4", status: "running", exitCode: null, output: "" }),
    ];
    expect(applyComputerCommandHistory(history, pending).map((entry) => entry.executionId)).toEqual(
      ["call-2", "call-3", "call-4"],
    );
    expect(applyComputerCommandHistory(history, []).map((entry) => entry.executionId)).toEqual([
      "call-2",
      "call-3",
    ]);
  });

  it("lets a live result replace the running command from the history page", () => {
    expect(
      applyComputerCommandHistory(
        [command({ status: "running", exitCode: null, output: "" })],
        [command()],
      ).map((entry) => entry.status),
    ).toEqual(["done"]);
  });

  it("caps the feed at the activity history window, keeping the newest commands", () => {
    const history = Array.from({ length: COMPUTER_COMMAND_FEED_LIMIT + 5 }, (_, index) =>
      command({ executionId: `call-${index}` }),
    );
    const merged = applyComputerCommandHistory(history, [
      command({ executionId: "call-live", status: "running", exitCode: null, output: "" }),
    ]);
    expect(merged).toHaveLength(COMPUTER_COMMAND_FEED_LIMIT);
    expect(merged.at(-1)?.executionId).toBe("call-live");
    expect(merged[0]?.executionId).toBe("call-6");
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
