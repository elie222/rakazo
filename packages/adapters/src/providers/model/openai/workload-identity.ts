import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ClientError, deadlineSignal, withAbort } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import * as z from "zod";

const Binding = z.object({
  tokenFile: z.string().min(1),
  identityProviderId: z.string().min(1),
  serviceAccountId: z.string().min(1),
});
const Token = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

const FILE_FAILURES = new Set([
  "EACCES",
  "EIO",
  "EISDIR",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
]);
const TRANSPORT_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "ETIMEDOUT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function knownFailureCode(error: unknown, allowed: ReadonlySet<string>) {
  for (
    let cause = error, depth = 0;
    cause instanceof Error && depth < 4;
    cause = cause.cause, depth += 1
  ) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code && allowed.has(code)) return code;
  }
  return undefined;
}

function logTransportFailure(phase: "fetch" | "read_response", error: unknown) {
  const code = knownFailureCode(error, TRANSPORT_CODES);
  const interrupted = error instanceof TypeError && error.message === "terminated";
  const redirected =
    error instanceof Error &&
    error.cause instanceof Error &&
    error.cause.message === "unexpected redirect";
  if (!code && !interrupted && !redirected) return false;
  getLogger().warn("OpenAI workload identity transport failed", { phase, code });
  return true;
}

export async function exchangeWorkloadIdentity(
  value: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const binding = Binding.safeParse(value);
  if (!binding.success) throw new ClientError("BAD_REQUEST", "Invalid model identity binding");
  const jwt = await readFile(binding.data.tokenFile, { encoding: "utf8", signal })
    .then((value) => value.trim())
    .catch((error: unknown) => {
      signal.throwIfAborted();
      const code = knownFailureCode(error, FILE_FAILURES);
      if (!code) throw new Error("Unexpected workload identity assertion read failure.");
      getLogger().warn("OpenAI workload identity assertion read failed", { code });
      throw new ClientError(
        "SERVICE_UNAVAILABLE",
        "Could not read the workload identity assertion.",
      );
    });
  if (!jwt)
    throw new ClientError("SERVICE_UNAVAILABLE", "The workload identity assertion is empty.");
  const response = await fetcher("https://auth.openai.com/oauth/token", {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: jwt,
      identity_provider_id: binding.data.identityProviderId,
      service_account_id: binding.data.serviceAccountId,
    }),
    signal,
  }).catch((error: unknown) => {
    signal.throwIfAborted();
    if (!logTransportFailure("fetch", error))
      throw new Error("Unexpected OpenAI token service request failure.");
    throw new ClientError("SERVICE_UNAVAILABLE", "Could not reach the OpenAI token service.");
  });
  if (!response.ok) {
    getLogger().warn("OpenAI workload identity exchange refused", { status: response.status });
    if (response.status === 429 || response.status >= 500)
      throw new ClientError("SERVICE_UNAVAILABLE", "The OpenAI token service is unavailable.");
    throw new ClientError(
      "BAD_REQUEST",
      "Model OAuth exchange failed. Check the workload identity binding.",
    );
  }
  const invalidResponse = () =>
    new ClientError(
      "SERVICE_UNAVAILABLE",
      "The OpenAI token service returned an invalid response.",
    );
  const payload = await response.json().catch((error: unknown) => {
    signal.throwIfAborted();
    if (error instanceof SyntaxError) throw invalidResponse();
    if (!logTransportFailure("read_response", error))
      throw new Error("Unexpected OpenAI token service response failure.");
    throw new ClientError(
      "SERVICE_UNAVAILABLE",
      "Could not read the OpenAI token service response.",
    );
  });
  signal.throwIfAborted();
  const token = Token.safeParse(payload);
  if (!token.success) throw invalidResponse();
  return { key: token.data.access_token, expiresAt: Date.now() + token.data.expires_in * 1000 };
}

// Read this only for the deployment model, not for personal provider connections.
export function configuredWorkloadIdentity(env: NodeJS.ProcessEnv) {
  const tokenFile = env.OPENAI_IDENTITY_TOKEN_FILE?.trim();
  const identityProviderId = env.OPENAI_IDENTITY_PROVIDER_ID?.trim();
  const serviceAccountId = env.OPENAI_SERVICE_ACCOUNT_ID?.trim();
  return tokenFile && isAbsolute(tokenFile) && identityProviderId && serviceAccountId
    ? { tokenFile, identityProviderId, serviceAccountId }
    : undefined;
}

export function createWorkloadIdentityKeyResolver(exchange = exchangeWorkloadIdentity) {
  type Access = Awaited<ReturnType<typeof exchange>>;
  let active: { id: string; token?: Access; pending?: Promise<Access> } | undefined;
  return async (env: NodeJS.ProcessEnv, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const binding = configuredWorkloadIdentity(env);
    if (!binding) {
      active = undefined;
      throw new ClientError("BAD_REQUEST", "The workload identity is not configured.");
    }
    const id = JSON.stringify(binding);
    if (active?.id !== id) active = { id };
    const entry = active;
    if (entry.token && entry.token.expiresAt - Date.now() > 30_000) return entry.token.key;
    // Cancellation stops the caller's wait, not a refresh other requests also need.
    if (!entry.pending) {
      const deadline = deadlineSignal(10_000);
      entry.pending = withAbort(exchange(binding, deadline), deadline)
        .then((token) => {
          if (token.expiresAt <= Date.now())
            throw new ClientError("SERVICE_UNAVAILABLE", "The workload identity token expired.");
          entry.token = token;
          return token;
        })
        .finally(() => {
          entry.pending = undefined;
        });
    }
    return (await (signal ? withAbort(entry.pending, signal) : entry.pending)).key;
  };
}

export const workloadIdentityKey = createWorkloadIdentityKeyResolver();
