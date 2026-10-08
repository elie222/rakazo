import type { SecretStore } from "@rakazo/adapter-kit";
import { AgentSecretInputSchema } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";

type EncryptedAgentSecret = {
  name: string;
  secret: { id: string; ciphertext: string };
};

export async function decryptAgentEnvironment(
  rows: EncryptedAgentSecret[],
  secrets: Pick<SecretStore, "load">,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      rows.map(async (row) => {
        AgentSecretInputSchema.shape.name.parse(row.name);
        return [row.name, await secrets.load(row.secret.ciphertext, row.secret.id)];
      }),
    ),
  );
}

export function formatAgentEnvironmentInstruction(
  environment: Record<string, string>,
): string | undefined {
  const names = Object.keys(environment).sort();
  if (names.length === 0) return undefined;
  return `Managed credentials are available to shell commands as these environment variables: ${names.join(", ")}. Use them without printing, logging, or embedding their values in files or messages.`;
}

export function redactAgentCommandResult(
  result: { stdout: string; stderr: string; code: number },
  secrets: string[],
) {
  return {
    ...result,
    stdout: redactSecrets(result.stdout, secrets),
    stderr: redactSecrets(result.stderr, secrets),
  };
}
