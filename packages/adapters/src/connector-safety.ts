import { redactSecrets } from "@rakazo/core";

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => Boolean(signal)));
}

export function sanitizeConnectorError(error: unknown, secrets: string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(
    message
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/trg_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted]"),
    secrets,
  ).slice(0, 2_000);
}

export function redactConnectorPayload(value: unknown, secrets: string[]): unknown {
  if (secrets.length === 0) return value;
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value), secrets));
  } catch {
    return { ok: true };
  }
}
