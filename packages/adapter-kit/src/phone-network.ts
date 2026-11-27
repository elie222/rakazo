import type { AdapterContext, AdapterDescriptor } from "./types.js";

/** An E.164 phone number, for example "+14155550123". */
export type PhoneNumber = string;

export type PhoneNetworkVerifyResult = { ok: true } | { ok: false; message: string };

export type PhoneNetworkCallRequest = {
  /** The destination, in E.164 form. */
  to: PhoneNumber;
  /** Overrides the provider's configured caller id when the operator supplied one. */
  from?: PhoneNumber;
  /** How long the provider should let the call ring before giving up. */
  timeoutSeconds?: number;
};

export type PhoneNetworkCallResult = {
  /** The provider's own id for this call, used to look the call up later. */
  callId: string;
  /** The provider's status for the call, for example "queued" or "ringing". */
  status: string;
  to: PhoneNumber;
  from?: PhoneNumber;
};

export type PhoneNetworkCapabilities = {
  /** Whether the provider can place outbound calls. */
  call: boolean;
};

/**
 * A phone-network provider: something that can place a real call on the public
 * telephone network. Kept apart from the in-app Call and from meeting bots, which
 * never touch a phone number.
 */
export interface PhoneNetworkProvider {
  describe(): AdapterDescriptor<PhoneNetworkCapabilities>;
  /** Checks the operator's credentials without placing a call. */
  verify(apiKey: string, context: AdapterContext): Promise<PhoneNetworkVerifyResult>;
  placeCall(
    request: PhoneNetworkCallRequest,
    context: AdapterContext,
  ): Promise<PhoneNetworkCallResult>;
}

/**
 * Normalizes a phone number to E.164.
 *
 * The rule is deliberately strict: the number must be written in international
 * form (a leading "+") so a country code is never guessed, and it must hold 7 to
 * 15 digits, the range E.164 allows. Spaces, hyphens, parentheses and dots are
 * formatting and get dropped; anything else makes the number unusable.
 *
 * Returns null when the input is not a number this provider can dial.
 */
export function normalizePhoneNumber(raw: string): PhoneNumber | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("+")) return null;
  const digits = trimmed.slice(1).replace(/[\s\-().]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length < 7 || digits.length > 15) return null;
  return `+${digits}`;
}
