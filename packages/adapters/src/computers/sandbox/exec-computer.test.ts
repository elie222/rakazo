import type { AdapterContext, ComputerRef, SkippedWorkspaceFile } from "@rakazo/adapter-kit";
import { SandboxFileTooLargeError } from "@rakazo/adapter-kit";
import * as Logging from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { tarHeader } from "../../storage/workspace-archive.test-support.js";
import type { RawExec } from "./exec-computer.js";
import { ExecComputer, encodeTarEntry, TarReader } from "./exec-computer.js";

describe("reading a file with a size limit", () => {
  it("refuses a file that grew past the limit after its size was checked, by type", async () => {
    const exec: RawExec = async function* (_computer, command) {
      // The timeout wrapper's words come first; the tool and its arguments follow.
      const tool = command.includes("stat") ? "stat" : "cat";
      yield { type: "stdout", data: Buffer.from(tool === "stat" ? "4" : "x".repeat(64)) };
      yield { type: "exit", code: 0 };
    };
    const computer = new ExecComputer(exec, "test");
    const context = { signal: new AbortController().signal } as AdapterContext;
    const read = computer.readFile({ id: "computer-1" } as ComputerRef, "notes.txt", context, {
      maxBytes: 8,
    });
    await expect(read).rejects.toBeInstanceOf(SandboxFileTooLargeError);
    await expect(read).rejects.toMatchObject({ maxBytes: 8 });
  });

  it("reports a read that only wrote diagnostics as a failed read, not an oversized file", async () => {
    const exec: RawExec = async function* (_computer, command) {
      const stat = command.includes("stat");
      yield stat
        ? { type: "stdout", data: Buffer.from("4") }
        : { type: "stderr", data: Buffer.from("cat: notes.txt: Permission denied ".repeat(4)) };
      yield { type: "exit", code: stat ? 0 : 1 };
    };
    const computer = new ExecComputer(exec, "test");
    const context = { signal: new AbortController().signal } as AdapterContext;
    const read = computer.readFile({ id: "computer-1" } as ComputerRef, "notes.txt", context, {
      maxBytes: 8,
    });
    await expect(read).rejects.not.toBeInstanceOf(SandboxFileTooLargeError);
    await expect(read).rejects.toThrow("command output is too large");
  });
});

describe("workspace archive packets", () => {
  it("reads a large file without repeatedly copying its accumulated bytes", () => {
    const content = Buffer.alloc(8 * 1024 * 1024, 173);
    const archive = Buffer.concat([
      ...encodeTarEntry("large.bin", content, false),
      ...encodeTarEntry("next.txt", Buffer.from("next"), true),
      Buffer.alloc(1024),
    ]);
    const concat = Buffer.concat;
    let copiedBytes = 0;
    const spy = vi.spyOn(Buffer, "concat").mockImplementation((chunks, length) => {
      copiedBytes += chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      return concat(chunks, length);
    });
    try {
      const reader = new TarReader(content.length);
      const files = [];
      for (let offset = 0; offset < archive.length; offset += 16381) {
        files.push(...reader.push(archive.subarray(offset, offset + 16381)));
      }
      reader.finish();
      expect(files.map((file) => file.path)).toEqual(["large.bin", "next.txt"]);
      expect(Buffer.compare(Buffer.from(files[0]!.content), content)).toBe(0);
      expect(Buffer.from(files[1]!.content).toString()).toBe("next");
      expect(files[1]!.executable).toBe(true);
      expect(copiedBytes).toBeLessThanOrEqual(archive.length * 2);
    } finally {
      spy.mockRestore();
    }
  });

  it("handles split headers, long paths, empty files and padding", () => {
    const name = `${"directory/".repeat(15)}file.txt`;
    const archive = Buffer.concat([
      ...encodeTarEntry("empty", Buffer.alloc(0), false),
      ...encodeTarEntry(name, Buffer.from("abc"), false),
      Buffer.alloc(1024),
    ]);
    const reader = new TarReader(10);
    const files = [];
    for (const byte of archive) files.push(...reader.push(Buffer.from([byte])));
    reader.finish();
    expect(files.map((file) => file.path)).toEqual(["empty", name]);
    expect(files[0]!.content.length).toBe(0);
    expect(Buffer.from(files[1]!.content).toString()).toBe("abc");
  });

  it("rejects truncated bodies and oversized files", () => {
    const archive = Buffer.concat([...encodeTarEntry("file", Buffer.from("abc"), false)]);
    const reader = new TarReader(3);
    reader.push(archive.subarray(0, 513));
    expect(() => reader.finish()).toThrow("ended inside a file");
    expect(() => new TarReader(2).push(archive)).toThrow("exceeds");
  });
});

describe("exporting a workspace with a per-file limit", () => {
  const computer = { id: "computer-1", kind: "test" } as ComputerRef;
  const context = { signal: new AbortController().signal } as AdapterContext;

  /** A computer whose home lists `names` and whose tar writes `archive`. */
  function exporting(names: string[], archive: Buffer): ExecComputer {
    const exec: RawExec = async function* (_computer, command, _signal, _timeout, stdin) {
      if (command.some((arg) => arg.includes("-printf"))) {
        yield { type: "stdout", data: Buffer.from(names.map((name) => `${name}\0`).join("")) };
      } else if (command.includes("tar")) {
        for (let offset = 0; offset < archive.length; offset += 65_521)
          yield { type: "stdout", data: archive.subarray(offset, offset + 65_521) };
      } else if (stdin) {
        for await (const _chunk of stdin) {
          // The staged file list.
        }
      }
      yield { type: "exit", code: 0 };
    };
    return new ExecComputer(exec, "test");
  }

  const home = () =>
    exporting(
      ["a.txt", "big.bin", "z.txt"],
      Buffer.concat([
        ...encodeTarEntry("a.txt", Buffer.from("a")),
        ...encodeTarEntry("big.bin", Buffer.alloc(2048, 7)),
        ...encodeTarEntry("z.txt", Buffer.from("z")),
        Buffer.alloc(1024),
      ]),
    );

  it("fails on a file over 64 MiB without a per-file limit, before reading its bytes", async () => {
    // The header claims the size; no data follows, so only a refusal at the header passes.
    const archive = Buffer.concat([
      tarHeader({ name: "huge.bin", size: 64 * 1024 * 1024 + 1 }),
      Buffer.alloc(1024),
    ]);
    const files: unknown[] = [];
    const exported = (async () => {
      for await (const file of exporting(["huge.bin"], archive).exportWorkspace(computer, context))
        files.push(file);
    })();
    await expect(exported).rejects.toBeInstanceOf(SandboxFileTooLargeError);
    expect(files).toEqual([]);
  });

  it("leaves out a file over limits.maxFileBytes, reports it and exports the rest", async () => {
    const skipped: SkippedWorkspaceFile[] = [];
    const files = [];
    for await (const file of home().exportWorkspace(computer, context, {
      maxBytes: 1024 * 1024,
      maxFiles: 10,
      maxFileBytes: 1024,
      onSkippedFile: (file) => skipped.push(file),
    }))
      files.push(file);
    expect(files).toEqual([
      { path: "a.txt", content: new Uint8Array(Buffer.from("a")) },
      { path: "z.txt", content: new Uint8Array(Buffer.from("z")) },
    ]);
    expect(skipped).toEqual([{ path: "big.bin", reason: "too_large", bytes: 2048, limit: 1024 }]);
  });

  it("logs the left-out file's path and size when the caller does not ask to be told", async () => {
    const warn = vi.fn();
    const logger = vi.spyOn(Logging, "getLogger").mockReturnValue({ warn } as never);
    try {
      const paths = [];
      for await (const file of home().exportWorkspace(computer, context, {
        maxBytes: 1024 * 1024,
        maxFiles: 10,
        maxFileBytes: 1024,
      }))
        paths.push(file.path);
      expect(paths).toEqual(["a.txt", "z.txt"]);
      expect(warn).toHaveBeenCalledWith("computer.checkpoint_file_skipped", {
        "computer.id": "computer-1",
        provider: "test",
        path: "big.bin",
        reason: "too_large",
        bytes: 2048,
        limit: 1024,
      });
    } finally {
      logger.mockRestore();
    }
  });
});
