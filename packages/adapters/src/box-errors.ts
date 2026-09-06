import { ResponseError } from "@asciidev/box-sdk";
import { redactSecrets } from "@rakazo/core";

/** Keep HTTP failures actionable without changing the SDK's status-based recovery contract. */
export function wrapBoxCall<Args extends unknown[], Result>(
  call: (...args: Args) => Promise<Result>,
  apiKey: string,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await call(...args);
    } catch (error) {
      if (error instanceof ResponseError) throw await boxResponseError(error.response, apiKey);
      throw error;
    }
  };
}

export async function boxResponseError(response: Response, apiKey: string): Promise<ResponseError> {
  const body = await readErrorBody(response);
  const code = safeIdentifier(body?.code);
  const requestId = safeIdentifier(body?.requestId);
  const prefix = `Box API request failed (HTTP ${response.status}${code ? `, ${code}` : ""})`;
  const detail =
    typeof body?.message === "string"
      ? redactSecrets(body.message, [apiKey])
          .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted URL]")
          .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 512)
      : "";
  return new ResponseError(
    response,
    redactSecrets(
      `${prefix}${detail ? `: ${detail}` : ""}${requestId ? ` (request ${requestId})` : ""}`,
      [apiKey],
    ),
  );
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(value) ? value : undefined;
}

async function readErrorBody(response: Response): Promise<Record<string, unknown> | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) return undefined;
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
