import { readFile } from "node:fs/promises";
import { ClientError } from "@rakazo/core";
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

export async function exchangeWorkloadIdentity(
  value: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const binding = Binding.safeParse(value);
  if (!binding.success) throw new ClientError("BAD_REQUEST", "Invalid model identity binding");
  const jwt = await readFile(binding.data.tokenFile, { encoding: "utf8", signal })
    .then((value) => value.trim())
    .catch(() => {
      signal.throwIfAborted();
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
  }).catch(() => {
    signal.throwIfAborted();
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
  const token = Token.safeParse(await response.json().catch(() => undefined));
  signal.throwIfAborted();
  if (!token.success)
    throw new ClientError(
      "SERVICE_UNAVAILABLE",
      "The OpenAI token service returned an invalid response.",
    );
  return { key: token.data.access_token, expiresAt: Date.now() + token.data.expires_in * 1000 };
}
