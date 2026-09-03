import { ORPCError } from "@orpc/server";
import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  createVoiceProvider,
  type EncryptedSecretStore,
  isVoiceProviderId,
  listVoiceCatalog,
  MAX_SPEAK_CHARS,
  MAX_TRANSCRIBE_BYTES,
  NoVoiceConfigured,
  voiceCatalogEntry,
} from "@rakazo/adapters";
import type { Actor, VoiceCredential, VoiceStatus } from "@rakazo/contracts";
import { toUtterances } from "@rakazo/core";
import {
  deleteUnreferencedCredentialSecret,
  findDefaultVoiceCredential,
  findVoiceCredential,
  IsolationError,
  newestVoiceCredentialOrder,
  Prisma,
  type PrismaClient,
  selectSpaceVoicePreference,
} from "@rakazo/db";
import type { Context, Hono } from "hono";
import { withSerializableRetry } from "./serializable-retry.js";

export interface VoiceDeps {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
}

export { listVoiceCatalog };

const SPEAK_TIMEOUT_MS = 60_000;

export function voiceContext(actor: Actor, signal?: AbortSignal): AdapterContext {
  return {
    operationId: "voice",
    traceId: "voice",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: signal ?? new AbortController().signal,
  };
}

export function catalogEntry(provider: string) {
  return voiceCatalogEntry(provider);
}

export function toVoiceStatus(cred: { provider: string; voiceId: string } | null): VoiceStatus {
  const entry = cred ? catalogEntry(cred.provider) : undefined;
  return {
    configured: Boolean(cred),
    ready: Boolean(cred?.voiceId),
    transcribe: Boolean(entry?.transcribe && cred),
    provider: cred?.provider ?? null,
    voiceId: cred?.voiceId ?? "",
  };
}

export function toVoiceCredential(row: {
  id: string;
  provider: string;
  isDefault: boolean;
  voiceId: string;
}): VoiceCredential {
  return {
    id: row.id,
    provider: row.provider,
    hasKey: true,
    isDefault: row.isDefault,
    voiceId: row.voiceId,
    transcribe: Boolean(catalogEntry(row.provider)?.transcribe),
  };
}

export async function loadDefaultVoiceCredential(deps: VoiceDeps, actor: Actor) {
  return loadVoiceCredential(deps, actor);
}

export async function loadVoiceCredential(deps: VoiceDeps, actor: Actor, provider?: string) {
  const cred = provider
    ? await findVoiceCredential(deps.prisma, actor, provider)
    : await findDefaultVoiceCredential(deps.prisma, actor);
  if (!cred) return null;
  const secret = await deps.prisma.secret.findFirst({
    where: { id: cred.secretId, userId: actor.userId, spaceId: null },
  });
  if (!secret) return null;
  return { cred, apiKey: deps.secrets.load(secret.ciphertext, secret.id) };
}

export async function resolveVoiceTarget(
  deps: VoiceDeps,
  actor: Actor,
  input: { botId?: string; voiceId?: string },
) {
  let botVoiceId: string | null = null;
  if (input.botId) {
    const bot = await deps.prisma.bot.findFirst({
      where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { voiceId: true },
    });
    if (!bot) throw new IsolationError();
    botVoiceId = bot.voiceId;
  }
  const loaded = await loadDefaultVoiceCredential(deps, actor);
  if (!loaded) throw new NoVoiceConfigured("key");
  const voiceId = input.voiceId || botVoiceId || loaded.cred.voiceId;
  if (!voiceId) throw new NoVoiceConfigured("voice");
  return { ...loaded, voiceId };
}

export async function persistVoiceCredential(
  deps: VoiceDeps,
  actor: Actor,
  input: {
    provider: string;
    plaintext: string;
    voiceId?: string;
    signal?: AbortSignal;
  },
): Promise<VoiceCredential> {
  if (!isVoiceProviderId(input.provider)) {
    throw new ORPCError("BAD_REQUEST", { message: "Unknown voice provider." });
  }
  const provider = createVoiceProvider(input.provider);
  const verified = await provider.verify(input.plaintext, voiceContext(actor, input.signal));
  if (!verified.ok) {
    throw new ORPCError("BAD_REQUEST", { message: verified.message ?? "That key was rejected." });
  }
  let voiceId = input.voiceId?.trim() ?? "";
  if (!voiceId) {
    const voices = await provider.listVoices(input.plaintext, voiceContext(actor, input.signal));
    voiceId = voices[0]?.id ?? "";
  }
  const stored = await deps.secrets.put(input.plaintext, voiceContext(actor, input.signal));
  const cred = await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const existing = await tx.userVoiceCredential.findFirst({
          where: { userId: actor.userId, provider: input.provider },
          orderBy: newestVoiceCredentialOrder,
        });
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: null,
            kind: "voice",
            ciphertext: stored.ciphertext,
          },
        });
        const credential = !existing
          ? await tx.userVoiceCredential.create({
              data: {
                userId: actor.userId,
                provider: input.provider,
                secretId: secret.id,
              },
            })
          : await tx.userVoiceCredential.update({
              where: { id: existing.id },
              data: { secretId: secret.id },
            });
        const previousPreference = existing
          ? await tx.spaceVoicePreference.findUnique({
              where: {
                spaceId_userId_credentialId: {
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                  credentialId: existing.id,
                },
              },
            })
          : null;
        const selectedVoiceId = voiceId || previousPreference?.voiceId || "";
        await selectSpaceVoicePreference(tx, actor, credential.id, selectedVoiceId);
        if (existing) {
          await deleteUnreferencedCredentialSecret(tx, {
            credentialKind: "voice",
            credentialId: existing.id,
            secretId: existing.secretId,
          });
        }
        return { ...credential, isDefault: true, voiceId: selectedVoiceId };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return toVoiceCredential(cred);
}

export async function prepareVoice(
  deps: VoiceDeps,
  actor: Actor,
  input: { text: string; voiceId?: string; botId?: string },
) {
  try {
    await resolveVoiceTarget(deps, actor, input);
  } catch (error) {
    if (error instanceof NoVoiceConfigured) {
      return { ready: false, utterances: [] as string[] };
    }
    throw error;
  }
  return { ready: true, utterances: toUtterances(input.text) };
}

export async function synthesizeVoice(
  deps: VoiceDeps,
  actor: Actor,
  input: { text: string; voiceId?: string; botId?: string; signal?: AbortSignal },
) {
  const target = await resolveVoiceTarget(deps, actor, input);
  const text = input.text.trim();
  if (!text) throw new ORPCError("BAD_REQUEST", { message: "Nothing to speak." });
  if (text.length > MAX_SPEAK_CHARS) {
    throw new ORPCError("BAD_REQUEST", { message: "That utterance is too long to speak." });
  }
  const provider = createVoiceProvider(target.cred.provider);
  return provider.synthesize(
    {
      text,
      voiceId: target.voiceId,
      apiKey: target.apiKey,
      signal: input.signal,
    },
    voiceContext(actor, input.signal),
  );
}

export async function transcribeVoice(
  deps: VoiceDeps,
  actor: Actor,
  input: { audio: Uint8Array; mimeType: string; signal?: AbortSignal },
) {
  const loaded = await loadDefaultVoiceCredential(deps, actor);
  if (!loaded) throw new NoVoiceConfigured("key");
  const provider = createVoiceProvider(loaded.cred.provider);
  if (!provider.transcribe) {
    throw new ORPCError("BAD_REQUEST", {
      message: "This voice provider does not transcribe audio. Use on-device dictation instead.",
    });
  }
  if (input.audio.byteLength === 0 || input.audio.byteLength > MAX_TRANSCRIBE_BYTES) {
    throw new ORPCError("BAD_REQUEST", { message: "That recording is empty or too large." });
  }
  return provider.transcribe(
    {
      audio: input.audio,
      mimeType: input.mimeType || "audio/webm",
      apiKey: loaded.apiKey,
      signal: input.signal,
    },
    voiceContext(actor, input.signal),
  );
}

export function mountVoiceHttpRoutes(
  app: Hono,
  deps: VoiceDeps,
  authenticate: (c: Context) => Promise<Actor | null>,
) {
  app.post("/api/voice/speak", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    try {
      const clip = await synthesizeVoice(deps, actor, {
        text: String((body as { text?: unknown }).text ?? ""),
        voiceId: optionalString((body as { voiceId?: unknown }).voiceId),
        botId: optionalString((body as { botId?: unknown }).botId),
        signal: AbortSignal.any(
          [c.req.raw.signal, AbortSignal.timeout(SPEAK_TIMEOUT_MS)].filter(
            Boolean,
          ) as AbortSignal[],
        ),
      });
      // Copy into a fresh ArrayBuffer-backed view: DOM-lib BodyInit rejects
      // Uint8Array<ArrayBufferLike> since TS 5.7.
      return new Response(new Uint8Array(clip.bytes), {
        headers: {
          "content-type": clip.mimeType,
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      return voiceHttpError(c, error);
    }
  });

  app.post("/api/voice/transcribe", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const audioBase64 = String((body as { audioBase64?: unknown }).audioBase64 ?? "");
    try {
      const audio = decodeAudioBase64(audioBase64);
      const result = await transcribeVoice(deps, actor, {
        audio,
        mimeType: String((body as { mimeType?: unknown }).mimeType ?? "audio/webm"),
        signal: c.req.raw.signal,
      });
      return c.json({ text: result.text });
    } catch (error) {
      return voiceHttpError(c, error);
    }
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decodeAudioBase64(value: string): Uint8Array {
  if (!value.trim()) throw new ORPCError("BAD_REQUEST", { message: "Recording is empty." });
  try {
    return new Uint8Array(Buffer.from(value, "base64"));
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Recording is not valid audio." });
  }
}

function voiceHttpError(c: Context, error: unknown) {
  if (error instanceof IsolationError) {
    return c.json({ error: "Resource not found" }, 404);
  }
  if (error instanceof NoVoiceConfigured) {
    return c.json({ error: error.message }, 409);
  }
  if (error instanceof ORPCError) {
    const code = String(error.code ?? "BAD_REQUEST");
    const status =
      code === "UNAUTHORIZED" ? 401 : code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 400;
    return c.json({ error: error.message }, status);
  }
  const message = error instanceof Error ? error.message : "Voice request failed.";
  return c.json({ error: message }, 502);
}
