import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Docker from "dockerode";
import type { z } from "zod";
import type { computerActionSchema } from "./supervisor-logic.js";
import {
  containerActionSteps,
  createDockerStreamDemuxer,
  demuxDockerStream,
  parseObservation,
  sandboxCommandTimedOut,
  sandboxTimeoutCommand,
} from "./supervisor-logic.js";

/** Cap buffered raw bytes for non-streaming container commands so one command cannot OOM the supervisor. */
export const DEFAULT_MAX_BUFFERED_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_WRITE_ERROR_OUTPUT_BYTES = 64 * 1024;
const SPOOL_READ_CHUNK_BYTES = 64 * 1024;
const BASE64_CHUNK_RE = /^[A-Za-z0-9+/=]+$/;

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeAll(handle: FileHandle, data: string): Promise<void> {
  const buf = Buffer.from(data, "ascii");
  let offset = 0;
  while (offset < buf.length) {
    const { bytesWritten } = await handle.write(buf, offset, buf.length - offset, null);
    if (bytesWritten <= 0) throw new Error("short write to file read spool");
    offset += bytesWritten;
  }
}

const READ_CONTAINER_FILE_SCRIPT = [
  "import base64, os, sys",
  "target, limit = sys.argv[1], int(sys.argv[2])",
  "chunk_size = 49152",
  "with open(target, 'rb') as source:",
  "  st = os.fstat(source.fileno())",
  "  if limit >= 0 and st.st_size > limit: sys.exit(42)",
  "  total = 0",
  "  carry = b''",
  "  while True:",
  "    want = chunk_size if limit < 0 else min(chunk_size, limit - total + 1)",
  "    data = source.read(want)",
  "    if not data: break",
  "    total += len(data)",
  "    if limit >= 0 and total > limit: sys.exit(42)",
  "    buf = carry + data",
  "    rem = len(buf) % 3",
  "    if rem:",
  "      carry = buf[-rem:]",
  "      buf = buf[:-rem]",
  "    else:",
  "      carry = b''",
  "    if buf:",
  "      sys.stdout.write(base64.b64encode(buf).decode('ascii'))",
  "      sys.stdout.flush()",
  "  if carry:",
  "    sys.stdout.write(base64.b64encode(carry).decode('ascii'))",
  "    sys.stdout.flush()",
].join("\n");

function utf8SliceWithinBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || !text) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (bytes + chBytes > maxBytes) break;
    bytes += chBytes;
    end += ch.length;
  }
  return text.slice(0, end);
}

function appendCappedDiagnostic(current: string, chunk: string, maxBytes: number): string {
  if (!chunk) return current;
  const remaining = maxBytes - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  return current + utf8SliceWithinBytes(chunk, remaining);
}

export type ReadContainerFileOutcome =
  | { kind: "too_large" }
  | { kind: "error"; stderr: string }
  | { kind: "stream"; body: ReadableStream<Uint8Array> };

export async function runContainerCommand(
  container: Docker.Container,
  argv: string[],
  options: {
    workingDir?: string;
    env?: string[];
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Written to stdin without closing it; requires `signal`, whose abort closes stdin. */
    stdin?: string;
    /**
     * Live stdout/stderr sink. When set, output streams directly without buffering the full
     * result in memory, and the returned `stdout` and `stderr` are empty strings.
     */
    onOutput?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void;
    /** Exposes flow control on the Docker exec stream for streaming callers. */
    onStream?: (controls: { pause: () => void; resume: () => void }) => void;
    /** Maximum raw bytes buffered when `onOutput` is not provided. */
    maxOutputBytes?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (options.stdin !== undefined && !options.signal) throw new Error("stdin requires a signal");
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs;
  const completionMarker = timeoutMs
    ? `/tmp/rakazo-command-${randomUUID()}.completed-124`
    : undefined;
  const command =
    completionMarker && timeoutMs !== undefined
      ? sandboxTimeoutCommand(argv, timeoutMs, completionMarker)
      : argv;
  const attachStdin = options.stdin !== undefined;
  const abortOption = options.signal ? { abortSignal: options.signal } : {};
  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
    ...(attachStdin ? { AttachStdin: true } : {}),
    WorkingDir: options.workingDir ?? "/home/rakazo",
    Env: options.env ?? [
      "DISPLAY=:1",
      "HOME=/home/rakazo",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ],
    ...abortOption,
  });
  options.signal?.throwIfAborted();
  const stream = await exec.start({ hijack: true, stdin: attachStdin, ...abortOption });
  if (options.signal?.aborted) {
    stream.destroy();
    throw options.signal.reason ?? new Error("command cancelled");
  }
  if (options.stdin !== undefined) stream.write(options.stdin);
  const streaming = Boolean(options.onOutput);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_BUFFERED_OUTPUT_BYTES;
  const chunks: Buffer[] = [];
  let bufferedBytes = 0;
  let sawStderr = false;
  let stderrEndedWithNewline = true;
  const demuxer = streaming ? createDockerStreamDemuxer() : undefined;
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (error !== undefined) reject(error);
        else resolve();
      };
      const emitOutput = (chunk: Buffer | string) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (demuxer && options.onOutput) {
          for (const piece of demuxer.push(bytes)) {
            if (!piece.data) continue;
            if (piece.stream === "stderr") {
              sawStderr = true;
              stderrEndedWithNewline = piece.data.endsWith("\n");
            }
            options.onOutput(piece);
            if (settled) return;
          }
          return;
        }
        bufferedBytes += bytes.length;
        if (bufferedBytes > maxOutputBytes) {
          stream.destroy();
          finish(new Error(`command output exceeded ${maxOutputBytes} bytes`));
          return;
        }
        chunks.push(bytes);
      };
      if (streaming && options.onStream) {
        options.onStream({
          pause: () => stream.pause(),
          resume: () => stream.resume(),
        });
      }
      stream.on("data", emitOutput);
      stream.on("end", () => finish());
      stream.on("error", (error: unknown) => finish(error));
      onAbort = () => {
        // Destroying the hijacked stream stops reads immediately and sends stdin EOF when attached.
        stream.destroy();
        finish(options.signal?.reason ?? new Error("command cancelled"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  } finally {
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
  if (demuxer && options.onOutput) {
    for (const piece of demuxer.finish()) {
      if (!piece.data) continue;
      if (piece.stream === "stderr") {
        sawStderr = true;
        stderrEndedWithNewline = piece.data.endsWith("\n");
      }
      options.onOutput(piece);
    }
  }
  options.signal?.throwIfAborted();
  const inspect = await (options.signal
    ? exec.inspect({ abortSignal: options.signal })
    : exec.inspect());
  const code = inspect.ExitCode ?? 0;
  const completedWithExit124 =
    code === 124 && completionMarker
      ? await consumeCompletionMarker(container, completionMarker, options.signal)
      : false;
  const timedOut = sandboxCommandTimedOut(code, completedWithExit124);
  if (streaming && options.onOutput) {
    if (timedOut && !options.signal?.aborted) {
      const prefix = sawStderr && !stderrEndedWithNewline ? "\n" : "";
      options.onOutput({
        stream: "stderr",
        data: `${prefix}command timed out after ${timeoutMs} ms\n`,
      });
    }
    return { stdout: "", stderr: "", code };
  }
  const output = demuxDockerStream(Buffer.concat(chunks));
  return {
    stdout: output.stdout,
    stderr: timedOut
      ? `${output.stderr}${output.stderr.endsWith("\n") || output.stderr === "" ? "" : "\n"}command timed out after ${timeoutMs} ms\n`
      : output.stderr,
    code,
  };
}

async function consumeCompletionMarker(
  container: Docker.Container,
  marker: string,
  signal?: AbortSignal,
) {
  const result = await runContainerCommand(
    container,
    ["sh", "-c", 'if [ -f "$0" ]; then rm -f "$0"; exit 0; fi; exit 1', marker],
    signal ? { signal } : {},
  );
  return result.code === 0;
}

export async function applyContainerActions(
  container: Docker.Container,
  actions: Array<z.infer<typeof computerActionSchema>>,
  display = ":1",
  browserProfile?: string,
) {
  const script = [
    "import json, subprocess, sys, time",
    "for step in json.loads(sys.argv[1]):",
    "  if 'waitMs' in step: time.sleep(step['waitMs'] / 1000)",
    "  else:",
    "    result = subprocess.run(step['argv'])",
    "    if result.returncode: sys.exit(result.returncode)",
  ].join("\n");
  const result = await runContainerCommand(container, [
    "python3",
    "-c",
    script,
    JSON.stringify(containerActionSteps(actions, display, browserProfile)),
  ]);
  if (result.code !== 0) throw new Error(result.stderr || "computer action failed");
}

export async function observeContainer(container: Docker.Container, display = ":1") {
  const command = [
    "set -e",
    `export DISPLAY=${display}`,
    'printf "GEOM %s\\n" "$(xdotool getdisplaygeometry 2>/dev/null || echo 1280 800)"',
    'printf "CURSOR %s\\n" "$(xdotool getmouselocation --shell 2>/dev/null | tr "\\n" " " || true)"',
    'wid="$(xdotool getactivewindow 2>/dev/null || true)"',
    'printf "WINDOW %s\\n" "$wid"',
    'printf "TITLE %s\\n" "$(test -n "$wid" && xdotool getwindowname "$wid" 2>/dev/null || true)"',
    'printf "IMAGE "',
    "import -window root png:- 2>/dev/null | base64 -w0",
    'printf "\\n"',
  ].join("; ");
  const result = await runContainerCommand(container, ["bash", "-lc", command]);
  if (result.code !== 0) throw new Error(result.stderr || "screen capture failed");
  return parseObservation(result.stdout);
}

async function readContainerFileSpooled(
  container: Docker.Container,
  target: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<ReadContainerFileOutcome> {
  const abort = new AbortController();
  const onCallerAbort = () => abort.abort(signal?.reason ?? new Error("file read cancelled"));
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (signal?.aborted) onCallerAbort();
  const cleanupCallerAbort = () => {
    signal?.removeEventListener("abort", onCallerAbort);
  };

  const encoder = new TextEncoder();
  const maxEncodedBytes = Math.ceil(maxBytes / 3) * 4;
  let encodedBytes = 0;
  let exceededLimit = false;
  let stderr = "";
  let failure: unknown;
  let streamControls: { pause: () => void; resume: () => void } | undefined;
  let inFlightWrites = 0;
  let spoolPath: string | undefined;
  let writeHandle: FileHandle | undefined;
  let pendingWrite: Promise<void> = Promise.resolve();
  let handedOff = false;

  const stopReading = (error: unknown) => {
    failure ??= error;
    abort.abort(error);
  };

  try {
    let exitCode: number | undefined;
    try {
      const result = await runContainerCommand(
        container,
        ["python3", "-c", READ_CONTAINER_FILE_SCRIPT, target, String(maxBytes)],
        {
          signal: abort.signal,
          onStream: (controls) => {
            streamControls = controls;
            if (inFlightWrites > 0) controls.pause();
          },
          onOutput: (chunk) => {
            if (chunk.stream === "stderr") {
              stderr = appendCappedDiagnostic(stderr, chunk.data, MAX_WRITE_ERROR_OUTPUT_BYTES);
              return;
            }
            if (!chunk.data || exceededLimit || failure !== undefined) return;
            if (!BASE64_CHUNK_RE.test(chunk.data)) {
              stopReading(new Error("invalid base64 file stream output"));
              return;
            }
            encodedBytes += chunk.data.length;
            if (encodedBytes > maxEncodedBytes) {
              exceededLimit = true;
              abort.abort(new Error(`computer file exceeds ${maxBytes} bytes`));
              return;
            }
            inFlightWrites += 1;
            streamControls?.pause();
            const data = chunk.data;
            pendingWrite = pendingWrite
              .then(async () => {
                if (exceededLimit || failure !== undefined || abort.signal.aborted) return;
                if (!writeHandle) {
                  spoolPath = path.join(tmpdir(), `rakazo-file-read-${randomUUID()}.b64`);
                  writeHandle = await open(spoolPath, "wx", 0o600);
                }
                await writeAll(writeHandle, data);
              })
              .catch((error: unknown) => {
                stopReading(error);
              })
              .finally(() => {
                inFlightWrites -= 1;
                if (
                  inFlightWrites === 0 &&
                  !exceededLimit &&
                  failure === undefined &&
                  !abort.signal.aborted
                ) {
                  streamControls?.resume();
                }
              });
          },
        },
      );
      exitCode = result.code;
    } catch (error) {
      failure ??= error;
    }

    await pendingWrite;
    if (writeHandle) {
      const handle = writeHandle;
      writeHandle = undefined;
      await handle.close();
    }

    if (exceededLimit || exitCode === 42) {
      return { kind: "too_large" };
    }
    if (failure !== undefined) {
      throw failure;
    }
    if (exitCode !== 0) {
      return { kind: "error", stderr };
    }
    if (!spoolPath) {
      return {
        kind: "stream",
        body: new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(encoder.encode('{"content":""}'));
            ctrl.close();
          },
        }),
      };
    }

    const filePath = spoolPath;
    let readHandle: FileHandle | undefined;
    let cleanedUp = false;
    const cleanupStream = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      const handle = readHandle;
      readHandle = undefined;
      try {
        await handle?.close();
      } finally {
        await unlinkIfPresent(filePath);
      }
    };
    const body = new ReadableStream<Uint8Array>(
      {
        start(ctrl) {
          ctrl.enqueue(encoder.encode('{"content":"'));
        },
        async pull(ctrl) {
          try {
            if (signal?.aborted) {
              await cleanupStream();
              ctrl.error(signal.reason ?? new Error("file read cancelled"));
              return;
            }
            if (!readHandle) readHandle = await open(filePath, "r");
            const buffer = Buffer.allocUnsafe(SPOOL_READ_CHUNK_BYTES);
            const { bytesRead } = await readHandle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) {
              await cleanupStream();
              ctrl.enqueue(encoder.encode('"}'));
              ctrl.close();
              return;
            }
            ctrl.enqueue(buffer.subarray(0, bytesRead));
          } catch (error) {
            await cleanupStream();
            ctrl.error(error);
          }
        },
        async cancel() {
          await cleanupStream();
        },
      },
      { highWaterMark: 1 },
    );
    handedOff = true;
    return { kind: "stream", body };
  } finally {
    cleanupCallerAbort();
    if (writeHandle) {
      const handle = writeHandle;
      writeHandle = undefined;
      await handle.close();
    }
    if (!handedOff && spoolPath) {
      await unlinkIfPresent(spoolPath);
    }
  }
}

export async function readContainerFile(
  container: Docker.Container,
  target: string,
  options: { maxBytes?: number; signal?: AbortSignal; signalMidStreamOverflow?: boolean } = {},
): Promise<ReadContainerFileOutcome> {
  // Older adapters during a rolling deploy expect HTTP 413 even if a file grows after reads start;
  // spool bounded legacy reads to disk so status is decided before headers without buffering in RAM.
  if (!options.signalMidStreamOverflow && options.maxBytes !== undefined) {
    return readContainerFileSpooled(container, target, options.maxBytes, options.signal);
  }
  const abort = new AbortController();
  const onCallerAbort = () =>
    abort.abort(options.signal?.reason ?? new Error("file read cancelled"));
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (options.signal?.aborted) onCallerAbort();
  const cleanupCallerAbort = () => {
    options.signal?.removeEventListener("abort", onCallerAbort);
  };

  const encoder = new TextEncoder();
  const maxEncodedBytes =
    options.maxBytes === undefined ? undefined : Math.ceil(options.maxBytes / 3) * 4;
  let encodedBytes = 0;
  let exceededLimit = false;
  let stderr = "";
  let streamControls: { pause: () => void; resume: () => void } | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamEnded = false;
  const buffered: string[] = [];
  let done = false;
  let exitCode: number | undefined;
  let failure: unknown;
  let settled = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const markReady = () => {
    if (!settled) {
      settled = true;
      resolveReady();
    }
  };
  const failStream = (error: unknown) => {
    failure ??= error;
    abort.abort(error);
    if (controller && !streamEnded) {
      streamEnded = true;
      cleanupCallerAbort();
      controller.error(error);
    }
    markReady();
  };
  const finishTooLargeIfAttached = () => {
    if (!controller || streamEnded) return;
    streamEnded = true;
    cleanupCallerAbort();
    if (options.signalMidStreamOverflow) {
      controller.enqueue(encoder.encode('","tooLarge":true}'));
      controller.close();
      return;
    }
    controller.error(new Error(`computer file exceeds ${options.maxBytes} bytes`));
  };
  const finishIfAttached = () => {
    if (!controller || streamEnded || !done) return;
    if (exceededLimit || exitCode === 42) {
      finishTooLargeIfAttached();
      return;
    }
    streamEnded = true;
    cleanupCallerAbort();
    if (failure !== undefined) {
      controller.error(failure);
      return;
    }
    if (exitCode !== 0) {
      controller.error(new Error(stderr || "file read failed"));
      return;
    }
    controller.enqueue(encoder.encode('"}'));
    controller.close();
  };

  void runContainerCommand(
    container,
    ["python3", "-c", READ_CONTAINER_FILE_SCRIPT, target, String(options.maxBytes ?? -1)],
    {
      signal: abort.signal,
      onStream: (controls) => {
        streamControls = controls;
        if (buffered.length > 0 && !controller) controls.pause();
      },
      onOutput: (chunk) => {
        if (chunk.stream === "stderr") {
          stderr = appendCappedDiagnostic(stderr, chunk.data, MAX_WRITE_ERROR_OUTPUT_BYTES);
          return;
        }
        if (!chunk.data || streamEnded) return;
        if (!BASE64_CHUNK_RE.test(chunk.data)) {
          failStream(new Error("invalid base64 file stream output"));
          return;
        }
        encodedBytes += chunk.data.length;
        if (maxEncodedBytes !== undefined && encodedBytes > maxEncodedBytes) {
          exceededLimit = true;
          finishTooLargeIfAttached();
          abort.abort(new Error(`computer file exceeds ${options.maxBytes} bytes`));
          markReady();
          return;
        }
        if (controller) {
          try {
            controller.enqueue(encoder.encode(chunk.data));
          } catch (error) {
            streamEnded = true;
            cleanupCallerAbort();
            abort.abort(error);
            return;
          }
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            streamControls?.pause();
          }
          return;
        }
        buffered.push(chunk.data);
        streamControls?.pause();
        markReady();
      },
    },
  ).then(
    (result) => {
      done = true;
      exitCode = result.code;
      markReady();
      finishIfAttached();
    },
    (error: unknown) => {
      done = true;
      failure ??= error;
      markReady();
      finishIfAttached();
    },
  );

  await ready;
  if (exceededLimit) {
    cleanupCallerAbort();
    return { kind: "too_large" };
  }
  if (failure !== undefined) {
    cleanupCallerAbort();
    throw failure;
  }
  if (done) {
    cleanupCallerAbort();
    if (exitCode === 42) return { kind: "too_large" };
    if (exitCode !== 0) return { kind: "error", stderr };
    if (buffered.length === 0) {
      return {
        kind: "stream",
        body: new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(encoder.encode('{"content":""}'));
            ctrl.close();
          },
        }),
      };
    }
  }

  const body = new ReadableStream<Uint8Array>(
    {
      start(ctrl) {
        controller = ctrl;
        ctrl.enqueue(encoder.encode('{"content":"'));
        for (const part of buffered) ctrl.enqueue(encoder.encode(part));
        buffered.length = 0;
        if (done) {
          finishIfAttached();
        } else if (ctrl.desiredSize === null || ctrl.desiredSize > 0) {
          streamControls?.resume();
        }
      },
      pull() {
        if (!done && !streamEnded) streamControls?.resume();
      },
      cancel() {
        streamEnded = true;
        cleanupCallerAbort();
        abort.abort(new Error("file read cancelled"));
      },
    },
    { highWaterMark: 1 },
  );
  return { kind: "stream", body };
}

export async function writeContainerFile(
  container: Docker.Container,
  target: string,
  content: Buffer,
  executable = false,
) {
  const script = [
    "import os, sys",
    "target = sys.argv[1]",
    "os.makedirs(os.path.dirname(target), exist_ok=True)",
    "with open(target, 'wb') as f: f.write(sys.stdin.buffer.read())",
    `os.chmod(target, ${executable ? "0o700" : "0o600"})`,
  ].join("\n");
  const exec = await container.exec({
    Cmd: ["python3", "-c", script, target],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: "/home/rakazo",
    Env: ["HOME=/home/rakazo"],
  });
  const stream = await exec.start({ hijack: true, stdin: true });
  const demuxer = createDockerStreamDemuxer();
  let stdout = "";
  let stderr = "";
  stream.on("data", (data: Buffer | string) => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    for (const piece of demuxer.push(bytes)) {
      if (piece.stream === "stderr") {
        stderr = appendCappedDiagnostic(stderr, piece.data, MAX_WRITE_ERROR_OUTPUT_BYTES);
      } else {
        stdout = appendCappedDiagnostic(stdout, piece.data, MAX_WRITE_ERROR_OUTPUT_BYTES);
      }
    }
  });
  stream.end(content);
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  for (const piece of demuxer.finish()) {
    if (piece.stream === "stderr") {
      stderr = appendCappedDiagnostic(stderr, piece.data, MAX_WRITE_ERROR_OUTPUT_BYTES);
    } else {
      stdout = appendCappedDiagnostic(stdout, piece.data, MAX_WRITE_ERROR_OUTPUT_BYTES);
    }
  }
  const inspect = await exec.inspect();
  if ((inspect.ExitCode ?? 0) !== 0) {
    throw new Error(stderr || stdout || "file write failed");
  }
}
