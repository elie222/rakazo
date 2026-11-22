import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import { parseRetryAfter } from "@rakazo/core";

const daytonaSdk = () => import("@daytona/sdk");

export async function daytonaRateLimitError(
  error: unknown,
): Promise<SandboxRateLimitError | undefined> {
  const { DaytonaRateLimitError } = await daytonaSdk();
  if (!(error instanceof DaytonaRateLimitError)) return undefined;
  const headers = (error as { headers?: unknown }).headers;
  const value: unknown =
    typeof (headers as { get?: unknown } | null)?.get === "function"
      ? (headers as { get: (name: string) => unknown }).get("retry-after")
      : (headers as Record<string, unknown> | null)?.["retry-after"];
  return new SandboxRateLimitError({
    cause: error,
    retryAfterMs: parseRetryAfter(typeof value === "string" ? value : undefined),
  });
}
