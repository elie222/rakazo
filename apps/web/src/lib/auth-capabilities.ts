import { readBoundedJsonResponse } from "@rakazo/core";

export interface AuthCapabilities {
  passwordReset: boolean;
  resetUrl: string | null;
  billing?: boolean;
}

const TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Public deployment capabilities, bounded in time and size so a stalled API cannot hang the UI. */
export async function fetchAuthCapabilities(): Promise<AuthCapabilities> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch("/api/auth/capabilities", { signal: controller.signal });
    if (!response.ok) throw new Error("Could not load authentication capabilities");
    return await readBoundedJsonResponse<AuthCapabilities>(
      response,
      MAX_RESPONSE_BYTES,
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
  }
}
