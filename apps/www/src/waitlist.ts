import { createHash } from "node:crypto";

const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CAPTURE_TIMEOUT_MS = 5_000;

export type WaitlistBody = {
  email: string;
  contactNote?: string;
};

type CaptureEnv = {
  PUBLIC_POSTHOG_HOST?: string;
  PUBLIC_POSTHOG_KEY?: string;
};

export function parseWaitlistBody(value: unknown): WaitlistBody | null {
  if (typeof value === "string") {
    try {
      return parseWaitlistBody(JSON.parse(value));
    } catch {
      return null;
    }
  }

  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const email = body.email;
  const contactNote = body.contactNote;
  if (typeof email !== "string") return null;
  if (contactNote === undefined) return { email };
  if (typeof contactNote === "string") return { email, contactNote };
  return null;
}

export function normalizeWaitlistEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

export async function captureWaitlistSignup(
  email: string,
  env: CaptureEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const apiKey = env.PUBLIC_POSTHOG_KEY?.trim();
  if (!apiKey) return false;

  const host = env.PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com";
  const joinedAt = new Date().toISOString();
  const distinctId = `waitlist:${createHash("sha256").update(email).digest("hex")}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);

  try {
    const response = await fetchImpl(new URL("/i/v0/e/", host), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        event: "waitlist_joined",
        distinct_id: distinctId,
        properties: {
          $process_person_profile: true,
          $set: { email, waitlist_status: "joined" },
          $set_once: { waitlist_joined_at: joinedAt, waitlist_source: "rakazo.com" },
        },
        timestamp: joinedAt,
      }),
      signal: controller.signal,
    });

    return response.ok;
  } finally {
    clearTimeout(timeout);
  }
}
