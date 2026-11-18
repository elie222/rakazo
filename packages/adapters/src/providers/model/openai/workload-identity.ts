import { readFile } from "node:fs/promises";
import { ClientError } from "@rakazo/core";
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
  try {
    const jwt = (await readFile(binding.data.tokenFile, { encoding: "utf8", signal })).trim();
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
    });
    if (!response.ok) throw new Error("Token exchange refused");
    const token = Token.parse(await response.json());
    return { key: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
  } catch {
    signal.throwIfAborted();
    throw new ClientError(
      "BAD_REQUEST",
      "Model OAuth exchange failed. Check the workload identity binding.",
    );
  }
}
