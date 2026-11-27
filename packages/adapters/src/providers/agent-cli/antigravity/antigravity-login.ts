import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthInteraction, OAuthCredential } from "@earendil-works/pi-ai";
import { bestEffort } from "@rakazo/logging";
import { cliEnv, stopProcessTree } from "../../../cli-models/cli-process.js";
import {
  ANTIGRAVITY_APP_DATA_DIR,
  antigravityProfileArgs,
  antigravityProfileEnv,
  ensureAntigravityProfileDir,
  removeAntigravityProfileDir,
} from "./antigravity-profiles.js";
import { ANTIGRAVITY_CLI_PROVIDER_ID } from "./provider-id.js";

const AUTH_URL_PATTERN = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/;
const AUTH_EMAIL_PATTERN = /authenticated successfully as ([^\s@<>"]+@[^\s@<>"]+)/i;
const AUTH_URL_WAIT_MS = 20_000;
const LOGIN_EXCHANGE_TIMEOUT_MS = 60_000;
const MAX_CAPTURED_OUTPUT = 16_384;

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length > MAX_CAPTURED_OUTPUT ? combined.slice(-MAX_CAPTURED_OUTPUT) : combined;
}

export interface AntigravityCliLoginOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  createProfileId?: () => string;
}

/**
 * Signs in one isolated Google account using Google's official `agy acp --login` CLI flow.
 * Rakazo never reads, parses, or stores Google's OAuth tokens: `agy` owns the entire exchange
 * and keeps its own credentials inside this connection's private `GEMINI_HOME` folder.
 */
export function createAntigravityCliLogin(options: AntigravityCliLoginOptions = {}) {
  const command = options.command ?? "agy";
  const baseEnv = options.env ?? process.env;
  const createProfileId = options.createProfileId ?? randomUUID;

  return async (interaction: AuthInteraction): Promise<OAuthCredential> => {
    const signal = interaction.signal ?? new AbortController().signal;
    if (signal.aborted) throw signal.reason ?? new Error("Sign-in cancelled.");

    const profileId = createProfileId();
    const profileDir = await ensureAntigravityProfileDir(profileId, baseEnv);

    const child = spawn(command, antigravityProfileArgs(profileDir, ["--login"]), {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...antigravityProfileEnv(profileDir, cliEnv(baseEnv)),
        BROWSER: "true",
        DISPLAY: "",
        WAYLAND_DISPLAY: "",
      },
    });

    child.stdin?.on("error", () => {});

    let succeeded = false;
    let output = "";
    let stderr = "";
    let resolveUrl: ((url: string) => void) | undefined;
    let rejectUrl: ((err: Error) => void) | undefined;
    const urlPromise = new Promise<string>((resolve, reject) => {
      resolveUrl = resolve;
      rejectUrl = reject;
    });

    const onChunk = (chunk: Buffer | string, isErr: boolean) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (isErr) stderr = appendBounded(stderr, text);
      else output = appendBounded(output, text);
      if (resolveUrl) {
        const match = AUTH_URL_PATTERN.exec(output) ?? AUTH_URL_PATTERN.exec(stderr);
        if (match?.[0]) {
          const done = resolveUrl;
          resolveUrl = undefined;
          rejectUrl = undefined;
          done(match[0]);
        }
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => onChunk(chunk, false));
    child.stderr?.on("data", (chunk: Buffer) => onChunk(chunk, true));

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", (err: NodeJS.ErrnoException) => {
          const error =
            err.code === "ENOENT"
              ? new Error(
                  "The Antigravity CLI (`agy`) is not installed on this server. Install it for the user running Rakazo.",
                )
              : err;
          rejectUrl?.(error);
          reject(error);
        });
        child.once("exit", (code, exitSignal) => {
          if (rejectUrl) {
            const detail = (stderr || output).trim();
            rejectUrl(
              new Error(
                detail
                  ? `Antigravity login exited before issuing a sign-in link: ${detail}`
                  : "Antigravity login exited before issuing a sign-in link.",
              ),
            );
          }
          resolve({ code, signal: exitSignal });
        });
      },
    );
    // Prevent an unhandled rejection if spawn fails before `exitPromise` is awaited.
    void bestEffort("antigravity login process exit", exitPromise);

    const onAbort = () => {
      stopProcessTree(child);
      rejectUrl?.(signal.reason instanceof Error ? signal.reason : new Error("Sign-in cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const authUrl = await withTimeout(
        urlPromise,
        AUTH_URL_WAIT_MS,
        "Timed out waiting for Antigravity CLI (`agy acp --login`) to print a Google sign-in link.",
      );
      if (signal.aborted) throw signal.reason ?? new Error("Sign-in cancelled.");

      interaction.notify({
        type: "auth_url",
        url: authUrl,
        instructions:
          "Sign in with your Google account in the browser, then paste the authorization code or landing URL.",
      });

      const pasted = await interaction.prompt({
        type: "manual_code",
        message: "Paste the authorization code or callback URL:",
        signal,
      });
      const trimmed = pasted.trim();
      if (!trimmed) throw new Error("Missing authorization code.");
      if (trimmed.includes("\n") || trimmed.includes("\r")) {
        throw new Error("Paste only the authorization code or callback URL on a single line.");
      }

      child.stdin?.write(`${trimmed}\n`);
      child.stdin?.end();

      const exited = await withTimeout(
        exitPromise,
        LOGIN_EXCHANGE_TIMEOUT_MS,
        "Antigravity sign-in timed out while completing Google authorization. Try again.",
      );
      if (exited.code !== 0) {
        const detail = (stderr || output).trim();
        throw new Error(
          detail
            ? `Antigravity sign-in failed: ${detail.slice(-300)}`
            : "Antigravity sign-in failed. Check the code and try again.",
        );
      }

      succeeded = true;
      const email = await extractAuthenticatedEmail(output, stderr, profileDir);
      const marker = `${ANTIGRAVITY_CLI_PROVIDER_ID}:${profileId}`;
      return {
        type: "oauth",
        access: marker,
        refresh: marker,
        // `agy` manages and refreshes its own Google tokens inside `profileDir`.
        expires: Number.MAX_SAFE_INTEGER,
        accountId: profileId,
        ...(email ? { email } : {}),
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      stopProcessTree(child);
      if (!succeeded) {
        await bestEffort(
          "remove failed antigravity profile dir",
          removeAntigravityProfileDir(profileId, baseEnv),
        );
      }
    }
  };
}

/**
 * Extracts the signed-in Google account email (for distinguishing multiple connections in the UI)
 * from `agy acp --login` output or its diagnostic login log. Never reads any token files.
 */
async function extractAuthenticatedEmail(
  stdout: string,
  stderr: string,
  profileDir: string,
): Promise<string | undefined> {
  const fromStreams = AUTH_EMAIL_PATTERN.exec(stdout)?.[1] ?? AUTH_EMAIL_PATTERN.exec(stderr)?.[1];
  if (fromStreams) return fromStreams;
  try {
    const logDir = join(profileDir, ANTIGRAVITY_APP_DATA_DIR, "log");
    const entries = (await readdir(logDir))
      .filter((name) => name.startsWith("acp-login-") && name.endsWith(".log"))
      .sort()
      .reverse();
    for (const entry of entries.slice(0, 3)) {
      const text = await readFile(join(logDir, entry), "utf8");
      const match = AUTH_EMAIL_PATTERN.exec(text);
      if (match?.[1]) return match[1];
    }
  } catch {
    // Email label is optional; fall back to the default connection name.
  }
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
