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
  let declared: number | null = null;
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maxBytes) {
      cancelBody(request.body);
      return null;
    }
    declared = contentLength;
  }

  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  // With a declared length the bytes land in one buffer; otherwise chunks are joined once at the end.
  let body = declared === null ? null : new Uint8Array(declared);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > maxBytes) {
        cancelBody(reader);
        return null;
      }
      if (body && bytes + value.byteLength <= body.byteLength) body.set(value, bytes);
      else {
        // A body longer than it declared: keep what came so far and finish as chunks.
        if (body) chunks.push(body.subarray(0, bytes));
        body = null;
        chunks.push(value);
      }
      bytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (body) return body.subarray(0, bytes);
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/** Best-effort body/reader cancel; must not delay a rejection response. */
export function cancelBody(body: { cancel(): Promise<void> } | null): void {
  try {
    void body?.cancel().catch(() => undefined);
  } catch {
    // Ignore cancel failures.
  }
}
