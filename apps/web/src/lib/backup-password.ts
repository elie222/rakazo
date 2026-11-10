/**
 * The backup password for account export/import. It encrypts only the
 * provider keys inside the export (see the WebDAV backup design); the zip
 * itself stays plaintext, and losing the password loses the keys for good.
 * The password is never stored anywhere — it lives in component state only
 * for the operation that needs it, and the breach check below fails open.
 */

export const BACKUP_PASSWORD_MIN_LENGTH = 12;
export const BACKUP_PASSWORD_RECOMMENDED_LENGTH = 16;
/** The import request carries the backup password in this header, never in the URL. */
export const BACKUP_PASSWORD_HEADER = "x-rakazo-backup-password";

export type BackupPasswordProblem = "too-short" | "mismatch";

/** Length and confirmation, checked before the password ever leaves the page. */
export function validateBackupPassword(
  password: string,
  confirm: string,
): BackupPasswordProblem | null {
  if (password.length < BACKUP_PASSWORD_MIN_LENGTH) return "too-short";
  if (password !== confirm) return "mismatch";
  return null;
}

const BREACH_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * Have I Been Pwned k-anonymity lookup, the same check the server runs for
 * new account passwords: only the first five SHA-1 characters leave the
 * browser. Fails open — an unreachable lookup never blocks an export.
 */
export async function isBackupPasswordBreached(password: string): Promise<boolean> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return false;
    const hash = await subtle.digest("SHA-1", new TextEncoder().encode(password));
    const hex = [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    const response = await fetch(`https://api.pwnedpasswords.com/range/${hex.slice(0, 5)}`, {
      headers: { "Add-Padding": "true" },
      signal: AbortSignal.timeout(BREACH_LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const suffix = `${hex.slice(5)}:`;
    return (await response.text())
      .split(/\r?\n/)
      .some(
        (line) => line.toUpperCase().startsWith(suffix) && Number(line.slice(suffix.length)) > 0,
      );
  } catch {
    return false;
  }
}

/**
 * The backup password only travels over HTTPS, except to a loopback dev
 * server. The page itself is the API's origin, so its protocol decides.
 */
export function canSendBackupPassword(
  location: Pick<Location, "protocol" | "hostname"> = window.location,
): boolean {
  if (location.protocol === "https:") return true;
  return (
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "[::1]"
  );
}
