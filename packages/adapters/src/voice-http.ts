/** Client disconnect plus a hard deadline — `context.signal` is always set. */
export function voiceDeadline(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

export function speechUploadName(mimeType?: string): string {
  const mime = (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime.includes("webm")) return "speech.webm";
  if (mime.includes("ogg") || mime.includes("opus")) return "speech.ogg";
  if (mime.includes("wav")) return "speech.wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "speech.mp3";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "speech.m4a";
  return "speech.webm";
}

export async function readVoiceJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function detail(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  if (typeof record.detail === "string" && record.detail.trim()) return record.detail.trim();
  if (
    record.detail &&
    typeof record.detail === "object" &&
    typeof (record.detail as { message?: unknown }).message === "string"
  ) {
    return String((record.detail as { message: string }).message).trim();
  }
  if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
  if (
    record.error &&
    typeof record.error === "object" &&
    typeof (record.error as { message?: unknown }).message === "string"
  ) {
    return String((record.error as { message: string }).message).trim();
  }
  return "";
}

export function voiceHttpError(
  status: number,
  provider: string,
  what: string,
  body: unknown,
): string {
  const theirs = detail(body);
  if (status === 401 || status === 403) {
    return `${provider} rejected that key. Check the key and that it has speech permissions.`;
  }
  if (status === 429)
    return theirs || `${provider} is rate-limiting this account — wait a moment and try again.`;
  if (status === 402) return theirs || `${provider} says this account is out of credit.`;
  return theirs ? `${what} failed: ${theirs}` : `${what} failed (${status})`;
}

export async function requireOk(res: Response, provider: string, what: string): Promise<Response> {
  if (res.ok) return res;
  throw new Error(voiceHttpError(statusFor(res), provider, what, await readVoiceJson(res)));
}

function statusFor(res: Response) {
  return res.status;
}
