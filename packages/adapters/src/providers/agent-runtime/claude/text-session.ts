import { createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { isRecord, redactSecrets } from "@rakazo/core";

const MAX_TRANSCRIPT_BYTES = 512 * 1024;
const FORMAT = "native-text-0.3.330-v1";
export const NATIVE_TEXT_PROJECT = "rakazo-native-text-v1";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Opaque host-side candidate. It is never sent to the web client or logged. */
export interface NativeTextSessionSnapshot {
  scope: string;
  sessionId: string;
  transcript: string;
  signature: string;
}

/** Explicit per-turn host input. A future caller must fence the actual durable commit. */
export type NativeTextSessionTurn = {
  spaceId: string;
  ownerId: string;
  profileRevision: string;
  // Stage only in this callback. Publish durably with a successful fenced run.
  onCandidate(snapshot: NativeTextSessionSnapshot): void;
} & ({ mode: "new" } | { mode: "resume"; previous: NativeTextSessionSnapshot });

export function nativeTextSessionScope(turn: NativeTextSessionTurn, request: AgentRunRequest) {
  const { model, botId, threadId } = request;
  if (
    !turn.spaceId ||
    !turn.ownerId ||
    !turn.profileRevision ||
    !botId ||
    !threadId ||
    !model.connectionId ||
    !model.apiKey ||
    model.billing !== "api_key"
  )
    throw new Error("A native session needs an exact owner, chat and named API-key connection.");
  return createHmac("sha256", model.apiKey)
    .update(
      JSON.stringify([
        FORMAT,
        turn.spaceId,
        turn.ownerId,
        botId,
        threadId,
        model.provider,
        model.id,
        model.connectionId,
        turn.profileRevision,
      ]),
    )
    .digest("hex");
}

function projectDir(scratch: string) {
  return join(scratch, "projects", NATIVE_TEXT_PROJECT);
}

function transcriptPath(scratch: string, sessionId: string) {
  if (!SESSION_ID.test(sessionId)) throw new Error("Invalid native session identifier.");
  return join(projectDir(scratch), `${sessionId}.jsonl`);
}

function validateTranscript(
  transcript: string,
  sessionId: string,
  secrets: readonly string[],
  assistantUuid?: string,
) {
  if (
    typeof transcript !== "string" ||
    !transcript.endsWith("\n") ||
    Buffer.byteLength(transcript) > MAX_TRANSCRIPT_BYTES ||
    redactSecrets(transcript, secrets) !== transcript
  )
    throw new Error("Native transcript is incomplete, too large or unsafe to retain.");
  let hasUser = false;
  let hasAssistant = false;
  for (const line of transcript.trimEnd().split("\n")) {
    const entry: unknown = JSON.parse(line);
    if (!isRecord(entry) || (entry.sessionId !== undefined && entry.sessionId !== sessionId))
      throw new Error("Native transcript session does not match.");
    if (entry.type === "user" && entry.sessionId === sessionId) hasUser = true;
    if (
      entry.type === "assistant" &&
      entry.sessionId === sessionId &&
      (!assistantUuid || entry.uuid === assistantUuid)
    )
      hasAssistant = true;
  }
  if (!hasUser || !hasAssistant) throw new Error("Native transcript is missing a complete turn.");
}

function snapshotSignature(key: string, scope: string, sessionId: string, transcript: string) {
  return createHmac("sha256", key)
    .update(JSON.stringify([FORMAT, "snapshot", scope, sessionId, transcript]))
    .digest();
}

export async function restoreNativeTextSession(
  scratch: string,
  scope: string,
  snapshot: NativeTextSessionSnapshot,
  key: string,
  secrets: readonly string[],
) {
  if (snapshot.scope !== scope)
    throw new Error("Native session belongs to another profile or chat.");
  const path = transcriptPath(scratch, snapshot.sessionId);
  validateTranscript(snapshot.transcript, snapshot.sessionId, secrets);
  if (
    !/^[0-9a-f]{64}$/.test(snapshot.signature) ||
    !timingSafeEqual(
      Buffer.from(snapshot.signature, "hex"),
      snapshotSignature(key, scope, snapshot.sessionId, snapshot.transcript),
    )
  )
    throw new Error("The native transcript snapshot failed integrity validation.");
  await mkdir(projectDir(scratch), { recursive: true, mode: 0o700 });
  await writeFile(path, snapshot.transcript, { flag: "wx", mode: 0o600 });
}

export async function captureNativeTextSession(
  scratch: string,
  scope: string,
  sessionId: string,
  assistantUuid: string,
  key: string,
  secrets: readonly string[],
): Promise<NativeTextSessionSnapshot> {
  const path = transcriptPath(scratch, sessionId);
  // Only read the one expected regular file within our scratch tree, not a config or sidecar.
  const expected = resolve(await realpath(scratch), "projects", NATIVE_TEXT_PROJECT);
  if ((await realpath(projectDir(scratch))) !== expected)
    throw new Error("Unexpected session directory.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_TRANSCRIPT_BYTES)
      throw new Error("Unexpected native transcript file.");
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error("Native transcript changed during capture.");
    const transcript = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    validateTranscript(transcript, sessionId, secrets, assistantUuid);
    return {
      scope,
      sessionId,
      transcript,
      signature: snapshotSignature(key, scope, sessionId, transcript).toString("hex"),
    };
  } finally {
    await file.close();
  }
}
