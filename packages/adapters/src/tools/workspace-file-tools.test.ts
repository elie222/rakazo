import type {
  AdapterContext,
  AgentToolExecutionResult,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { SandboxFileTooLargeError } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { TOOL_IMAGE_MAX_BYTES } from "../media/tool-result-image.js";
import { IMAGE_MODEL_CANNOT_SEE } from "../media/tool-result-image.prompt.js";
import { TOOL_RESULT_TEXT_LIMIT } from "../runtime/pi/pi-runtime-limits.js";
import type { RunWorkspace } from "./workspace-file-tools.js";
import { readFileFromTool } from "./workspace-file-tools.js";

function fileWorkspace(content: string | Uint8Array, runSecrets: string[] = []) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const maxBytesSeen: Array<number | undefined> = [];
  const computer: ComputerRef = {
    id: "computer-1",
    botId: "bot-1",
    kind: "fake",
    providerRef: "test-sandbox",
  };
  const sandbox = {
    readFile: async (
      _computer: ComputerRef,
      _path: string,
      _context: unknown,
      options?: { maxBytes?: number },
    ) => {
      maxBytesSeen.push(options?.maxBytes);
      if (options?.maxBytes !== undefined && bytes.byteLength > options.maxBytes)
        throw new SandboxFileTooLargeError(options.maxBytes);
      return bytes;
    },
  } as unknown as SandboxProvider;
  const workspace: RunWorkspace = {
    botId: "bot-1",
    computerMode: "dedicated",
    computer: async () => computer,
    markDirty: () => {},
    context: {} as AdapterContext,
    runSecrets,
  };
  return { sandbox, workspace, maxBytesSeen };
}

type ReadFileResult = {
  path?: string;
  content?: string;
  error?: string;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  nextOffset?: number;
  note?: string;
};

/** Walk a file chunk by chunk the way the model would, following nextOffset. */
async function readFileInChunks(content: string, runSecrets: string[] = []) {
  const { sandbox, workspace } = fileWorkspace(content, runSecrets);
  const chunks: ReadFileResult[] = [];
  let offset: number | undefined;
  for (let call = 0; call < 60; call += 1) {
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "docs/reference.txt",
      ...(offset === undefined ? {} : { offset }),
    })) as ReadFileResult;
    // No read_file result may reach the generic tool-result truncation.
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_LIMIT);
    expect(result.error).toBeUndefined();
    chunks.push(result);
    if (result.nextOffset === undefined) return chunks;
    expect(result.note).toContain(`offset: ${result.nextOffset}`);
    offset = result.nextOffset;
  }
  throw new Error("read_file never reached the end of the file");
}

describe("readFileFromTool ranges", () => {
  const referenceLines = Array.from(
    { length: 700 },
    (_, index) => `Entry ${String(index + 1).padStart(4, "0")} of the packaging reference guide.`,
  );
  const referenceText = referenceLines.join("\n");

  it("returns a 30 kB file in chunks that reassemble the exact original text", async () => {
    expect(new TextEncoder().encode(referenceText).byteLength).toBeGreaterThan(30_000);
    const chunks = await readFileInChunks(referenceText);
    expect(chunks.length).toBeGreaterThan(1);

    const first = chunks[0]!;
    expect(first.startLine).toBe(1);
    expect(first.totalLines).toBe(referenceLines.length);
    expect(first.nextOffset).toBeGreaterThan(1);

    let expectedStart = 1;
    for (const chunk of chunks) {
      expect(chunk.startLine).toBe(expectedStart);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine!);
      expectedStart = chunk.endLine! + 1;
    }
    const last = chunks.at(-1)!;
    expect(last.endLine).toBe(referenceLines.length);
    expect(last.nextOffset).toBeUndefined();
    expect(chunks.map((chunk) => chunk.content).join("\n")).toBe(referenceText);
  });

  it("returns exactly the requested offset and limit lines", async () => {
    const { sandbox, workspace } = fileWorkspace(referenceText);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "docs/reference.txt",
      offset: 20,
      limit: 5,
    })) as ReadFileResult;
    expect(result.content).toBe(referenceLines.slice(19, 24).join("\n"));
    expect(result.startLine).toBe(20);
    expect(result.endLine).toBe(24);
    expect(result.totalLines).toBe(referenceLines.length);
    expect(result.nextOffset).toBe(25);
  });

  it("clamps a requested range to the end of the file", async () => {
    const { sandbox, workspace } = fileWorkspace(referenceText);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "docs/reference.txt",
      offset: referenceLines.length - 1,
      limit: 50,
    })) as ReadFileResult;
    expect(result.content).toBe(referenceLines.slice(-2).join("\n"));
    expect(result.endLine).toBe(referenceLines.length);
    expect(result.nextOffset).toBeUndefined();
  });

  it("returns a small file whole when no range is given", async () => {
    const text = "alpha\nbeta\ngamma";
    const { sandbox, workspace } = fileWorkspace(text);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/short.txt",
    })) as ReadFileResult;
    expect(result).toEqual({
      path: "notes/short.txt",
      content: text,
      totalLines: 3,
      startLine: 1,
      endLine: 3,
    });
  });

  it("ignores range arguments that are not positive integers", async () => {
    const text = "alpha\nbeta\ngamma";
    const { sandbox, workspace } = fileWorkspace(text);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/short.txt",
      offset: -2,
      limit: 1.5,
    })) as ReadFileResult;
    expect(result.content).toBe(text);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(3);
  });

  it("redacts a secret that straddles a chunk boundary before the file is split", async () => {
    // Discover where the first chunk boundary falls, then put a secret across it.
    const plainChunks = await readFileInChunks(referenceText);
    const boundary = plainChunks[0]!.endLine!;
    const secret = "tok-live-boundary\nstraddle-secret";
    const lines = [...referenceLines];
    lines[boundary - 1] = `token: tok-live-boundary`;
    lines[boundary] = `straddle-secret ends the entry.`;
    const text = lines.join("\n");

    const chunks = await readFileInChunks(text, [secret]);
    const joined = chunks.map((chunk) => chunk.content).join("\n");
    expect(joined).not.toContain("tok-live-boundary");
    expect(joined).not.toContain("straddle-secret");
    expect(joined).toContain("[redacted]");
    expect(joined).toBe(redactSecrets(text, [secret]));
  });

  it("cuts a single line that alone exceeds the result limit and points past it", async () => {
    const text = `${"a".repeat(20_000)}\nshort tail line`;
    const chunks = await readFileInChunks(text);
    expect(chunks).toHaveLength(2);

    const first = chunks[0]!;
    expect(first.startLine).toBe(1);
    expect(first.endLine).toBe(1);
    expect(first.totalLines).toBe(2);
    expect(first.content!.length).toBeLessThan(20_000);
    expect(first.note).toContain("longer than the result limit");
    expect(first.nextOffset).toBe(2);

    expect(chunks[1]!.content).toBe("short tail line");
    expect(chunks[1]!.startLine).toBe(2);
    expect(chunks[1]!.endLine).toBe(2);
    expect(chunks[1]!.nextOffset).toBeUndefined();
  });

  it("never exposes a secret that crosses the cut inside one oversized line", async () => {
    const secret = "tok-live-cutpoint-secret-000111222333444";
    // Find where the line is cut without redaction, then put the secret across that point:
    // cutting before redacting would leak the part of the secret in front of the cut.
    const unredacted = fileWorkspace("x".repeat(20_000));
    const probe = (await readFileFromTool(unredacted.sandbox, unredacted.workspace, {
      path: "logs/one-line.log",
    })) as ReadFileResult;
    const cut = probe.content!.length;
    const text = `${"x".repeat(cut - 20)}${secret}${"y".repeat(8_000)}`;
    const { sandbox, workspace } = fileWorkspace(text, [secret]);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "logs/one-line.log",
    })) as ReadFileResult;
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_LIMIT);
    expect(result.content).not.toContain(secret.slice(0, 6));
    expect(result.content).toContain("[redacted]");
    expect(result.note).toContain("longer than the result limit");
    expect(result.nextOffset).toBeUndefined();
  });

  it("reports a clear error when offset is past the end of the file", async () => {
    const { sandbox, workspace } = fileWorkspace("alpha\nbeta\ngamma");
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/short.txt",
      offset: 500,
    })) as ReadFileResult;
    expect(result.error).toContain("past the end");
    expect(result.totalLines).toBe(3);
  });

  it("does not count the empty segment after a trailing newline as a line", async () => {
    const { sandbox, workspace } = fileWorkspace("a\nb\n");
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/two.txt",
      limit: 2,
    })) as ReadFileResult;
    expect(result).toEqual({
      path: "notes/two.txt",
      content: "a\nb\n",
      totalLines: 2,
      startLine: 1,
      endLine: 2,
    });
  });

  it("reassembles a file with a trailing newline exactly when read one line at a time", async () => {
    const { sandbox, workspace } = fileWorkspace("a\nb\n");
    const first = (await readFileFromTool(sandbox, workspace, {
      path: "notes/two.txt",
      offset: 1,
      limit: 1,
    })) as ReadFileResult;
    const second = (await readFileFromTool(sandbox, workspace, {
      path: "notes/two.txt",
      offset: 2,
      limit: 1,
    })) as ReadFileResult;
    expect(first.content).toBe("a");
    expect(first.nextOffset).toBe(2);
    expect(second.content).toBe("b\n");
    expect(second.endLine).toBe(2);
    expect(second.nextOffset).toBeUndefined();
    expect(second.note).toBeUndefined();
    expect([first.content, second.content].join("\n")).toBe("a\nb\n");
  });

  it("keeps a CRLF file's line endings and counts its lines correctly", async () => {
    const { sandbox, workspace } = fileWorkspace("a\r\nb\r\n");
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/crlf.txt",
    })) as ReadFileResult;
    expect(result.content).toBe("a\r\nb\r\n");
    expect(result.totalLines).toBe(2);
    expect(result.endLine).toBe(2);
    expect(result.nextOffset).toBeUndefined();
  });

  it("leaves a file without a trailing newline unchanged", async () => {
    const { sandbox, workspace } = fileWorkspace("a\nb");
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/no-newline.txt",
      limit: 2,
    })) as ReadFileResult;
    expect(result).toEqual({
      path: "notes/no-newline.txt",
      content: "a\nb",
      totalLines: 2,
      startLine: 1,
      endLine: 2,
    });
  });

  it("reads an empty file as one empty line, as before", async () => {
    const { sandbox, workspace } = fileWorkspace("");
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/empty.txt",
    })) as ReadFileResult;
    expect(result).toEqual({
      path: "notes/empty.txt",
      content: "",
      totalLines: 1,
      startLine: 1,
      endLine: 1,
    });
  });

  it("reports an offset that points past the real last line, not the phantom line", async () => {
    const { sandbox, workspace } = fileWorkspace("a\nb\n");
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/two.txt",
      offset: 3,
    })) as ReadFileResult;
    expect(result.error).toBe("offset 3 is past the end of the file, which has 2 lines");
    expect(result.totalLines).toBe(2);
  });
});

describe("readFileFromTool size limit", () => {
  function failingWorkspace(error: Error) {
    const { workspace } = fileWorkspace("");
    const sandbox = {
      readFile: async () => {
        throw error;
      },
    } as unknown as SandboxProvider;
    return { sandbox, workspace };
  }

  it("points the model at the shell for a file over the limit, even with a line range", async () => {
    const { sandbox, workspace } = failingWorkspace(new SandboxFileTooLargeError(1024));
    expect(
      await readFileFromTool(sandbox, workspace, { path: "logs/huge.log", offset: 1, limit: 50 }),
    ).toEqual({
      error: "file is over 250 KB; read parts of logs/huge.log with shell (grep, sed -n, tail)",
      path: "logs/huge.log",
    });
  });

  it("names a Team Computer's shared file as the shell reaches it from the bot's home", async () => {
    const { sandbox, workspace } = failingWorkspace(new SandboxFileTooLargeError(1024));
    const result = (await readFileFromTool(
      sandbox,
      { ...workspace, computerMode: "team" },
      { path: "shared/huge.log" },
    )) as { error: string };
    expect(result.error).toContain("read parts of ../../shared/huge.log with shell");
  });

  it("lets a computer failure that only mentions a size fail the tool call", async () => {
    const failure = new Error("command output exceeds 1024 bytes");
    const { sandbox, workspace } = failingWorkspace(failure);
    await expect(readFileFromTool(sandbox, workspace, { path: "logs/huge.log" })).rejects.toBe(
      failure,
    );
  });
});

describe("readFileFromTool images", () => {
  // Noise keeps the PNG from compressing below the text read limit.
  async function photo(width: number, height: number) {
    const pixels = Buffer.alloc(width * height * 3);
    let seed = 1;
    for (let index = 0; index < pixels.length; index += 1) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels[index] = seed & 0xff;
    }
    return sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
  }

  it("hands an image larger than the text limit to a vision model", async () => {
    const bytes = await photo(400, 300);
    expect(bytes.byteLength).toBeGreaterThan(250_000);
    const { sandbox, workspace, maxBytesSeen } = fileWorkspace(bytes);
    const result = (await readFileFromTool(
      sandbox,
      workspace,
      { path: "shots/page.png" },
      undefined,
      true,
    )) as AgentToolExecutionResult;
    expect(maxBytesSeen).toEqual([TOOL_IMAGE_MAX_BYTES]);
    expect(result.kind).toBe("agent_tool_result");
    expect(result.details).toEqual({
      path: "shots/page.png",
      mimeType: "image/png",
      width: 400,
      height: 300,
    });
    expect(result.content.map((part) => part.type)).toEqual(["text", "image"]);
  });

  it("reads an image larger than the text limit whatever its name", async () => {
    const bytes = await photo(400, 300);
    expect(bytes.byteLength).toBeGreaterThan(250_000);
    const { sandbox, workspace } = fileWorkspace(bytes);
    const result = (await readFileFromTool(
      sandbox,
      workspace,
      { path: "download" },
      undefined,
      true,
    )) as AgentToolExecutionResult;
    expect(result.details).toMatchObject({ mimeType: "image/png", width: 400, height: 300 });
  });

  it("keeps the text limit for a large file that is not an image", async () => {
    const { sandbox, workspace } = fileWorkspace("x".repeat(250_001));
    expect(await readFileFromTool(sandbox, workspace, { path: "logs/big.log" })).toEqual({
      error: "file is over 250 KB; read parts of logs/big.log with shell (grep, sed -n, tail)",
      path: "logs/big.log",
      size: 250_001,
    });
  });

  it("recognizes an image by its bytes whatever its name", async () => {
    const { sandbox, workspace } = fileWorkspace(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } })
        .jpeg()
        .toBuffer(),
    );
    const result = (await readFileFromTool(
      sandbox,
      workspace,
      { path: "download.bin" },
      undefined,
      true,
    )) as AgentToolExecutionResult;
    expect(result.details).toMatchObject({ mimeType: "image/jpeg", width: 8, height: 8 });
  });

  it("tells a text-only model the file is an image", async () => {
    const { sandbox, workspace } = fileWorkspace(await photo(10, 10));
    await expect(readFileFromTool(sandbox, workspace, { path: "a.png" })).resolves.toEqual({
      path: "a.png",
      mimeType: "image/png",
      error: IMAGE_MODEL_CANNOT_SEE,
    });
  });

  it("refuses an image over the image limit", async () => {
    const { sandbox, workspace } = fileWorkspace(new Uint8Array(TOOL_IMAGE_MAX_BYTES + 1));
    await expect(
      readFileFromTool(sandbox, workspace, { path: "huge.jpg" }, undefined, true),
    ).resolves.toEqual({ error: "image is over 10 MB", path: "huge.jpg" });
  });

  it("still sends other binary files to open_path", async () => {
    const { sandbox, workspace, maxBytesSeen } = fileWorkspace(new Uint8Array([0xff, 0xfe, 0x00]));
    const result = (await readFileFromTool(
      sandbox,
      workspace,
      { path: "data.bin" },
      undefined,
      true,
    )) as ReadFileResult;
    expect(maxBytesSeen).toEqual([TOOL_IMAGE_MAX_BYTES]);
    expect(result.error).toContain("open_path");
  });
});
