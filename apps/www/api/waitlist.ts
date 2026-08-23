import {
  captureWaitlistSignup,
  normalizeWaitlistEmail,
  parseWaitlistBody,
} from "../src/waitlist.js";

const MAX_BODY_BYTES = 2_048;

function json(status: number, body: unknown) {
  return Response.json(body, {
    status,
    headers: { Allow: "POST", "Cache-Control": "no-store" },
  });
}

async function readBody(request: Request): Promise<string | null> {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function fetchWaitlist(request: Request) {
  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES) {
      return json(400, { error: "Invalid request" });
    }
  }

  const rawBody = await readBody(request).catch(() => null);
  const body = rawBody === null ? null : parseWaitlistBody(rawBody);
  if (!body) {
    return json(400, { error: "Enter a valid email address" });
  }

  // A hidden field catches basic form spam without confirming the trap to bots.
  if (body.contactNote?.trim()) {
    return json(200, { ok: true });
  }

  const email = normalizeWaitlistEmail(body.email);
  if (!email) {
    return json(400, { error: "Enter a valid email address" });
  }

  const captured = await captureWaitlistSignup(email, process.env).catch(() => false);
  if (!captured) {
    return json(503, { error: "Waitlist is temporarily unavailable" });
  }

  return json(200, { ok: true });
}

export default { fetch: fetchWaitlist };
