/** Reads a request body without buffering more than maxBytes. */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  const bytes = await readBoundedBytes(request, maxBytes);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/** Reads a request body as bytes without buffering more than maxBytes. */
export async function readBoundedBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maxBytes) {
      cancelBody(request.body);
      return null;
    }
  }

  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        cancelBody(reader);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Best-effort body/reader cancel; must not delay a rejection response. */
export function cancelBody(body: { cancel(): Promise<void> } | null): void {
  try {
    void body?.cancel().catch(() => undefined);
  } catch {
    // Ignore cancel failures.
  }
}
