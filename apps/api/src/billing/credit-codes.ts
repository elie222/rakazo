export interface CreditCode {
  code: string;
  creditCents: number;
  /** How many accounts may redeem it; null when unlimited. */
  maxClaims: number | null;
}

// Long enough that guessing one is impractical.
const CREDIT_CODE = /^[A-Z0-9_-]{8,64}$/;

/** CREDIT_CODES: comma-separated `CODE:dollars` or `CODE:dollars:max-accounts`, codes matched case-insensitively. */
export function parseCreditCodes(value: string | undefined): Map<string, CreditCode> {
  const codes = new Map<string, CreditCode>();
  for (const entry of (value ?? "").split(",").map((part) => part.trim())) {
    if (!entry) continue;
    const [rawCode = "", dollars = "", claims, ...extra] = entry.split(":");
    const code = rawCode.trim().toUpperCase();
    const creditCents = /^\d{1,4}(\.\d{1,2})?$/.test(dollars)
      ? Math.round(Number(dollars) * 100)
      : 0;
    const maxClaims =
      claims === undefined ? null : /^[1-9]\d{0,5}$/.test(claims) ? Number(claims) : 0;
    if (
      !CREDIT_CODE.test(code) ||
      extra.length ||
      creditCents <= 0 ||
      creditCents > 100_000 ||
      maxClaims === 0 ||
      codes.has(code)
    )
      throw new Error(
        "CREDIT_CODES must list CODE:dollars or CODE:dollars:max-accounts, with codes of 8 to 64 letters, digits, _ or -",
      );
    codes.set(code, { code, creditCents, maxClaims });
  }
  return codes;
}
