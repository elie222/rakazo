import { AgentSecretInputSchema } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";

type EncryptedAgentSecret = {
  name: string;
  secret: { id: string; ciphertext: string };
};

type SecretLoader = {
  load(ciphertext: string, recordId: string): string;
};

export function decryptAgentEnvironment(
  rows: EncryptedAgentSecret[],
  secrets: SecretLoader,
): Record<string, string> {
  return Object.fromEntries(
    rows.map((row) => {
      AgentSecretInputSchema.shape.name.parse(row.name);
      return [row.name, secrets.load(row.secret.ciphertext, row.secret.id)];
    }),
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
