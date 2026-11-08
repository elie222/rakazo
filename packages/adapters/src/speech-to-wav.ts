import { spawn } from "node:child_process";

/** Browser and mobile recordings become mono PCM WAV without touching disk. */
export function speechToWav(
  audio: Uint8Array,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "pipe",
        "-threads",
        "1",
        "-i",
        "pipe:0",
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-threads",
        "1",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        "pipe:1",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH },
        signal,
        killSignal: "SIGKILL",
        windowsHide: true,
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        failure = new Error("Converted recording is too large.");
        child.kill("SIGKILL");
      } else if (!failure) chunks.push(chunk);
    });
    // Drain diagnostics, but never expose recordings or filesystem details in errors.
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure = signal.aborted
        ? new Error("Audio conversion was cancelled.")
        : new Error(
            error.code === "ENOENT"
              ? "Install ffmpeg on the speech server to transcribe this recording format."
              : "Audio conversion failed.",
          );
    });
    child.on("close", (code) => {
      if (failure) reject(failure);
      else if (code !== 0 || size <= 44) reject(new Error("Recording could not be decoded."));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(audio);
  });
}
