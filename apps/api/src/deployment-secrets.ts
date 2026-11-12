import type { SecretStore } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";

/**
 * Deletes a value the deployment no longer uses from the secret store, which keeps every saved
 * value until it is deleted there too. A failure leaves only that unused value behind, so it is
 * logged for the operator instead of failing the admin's change. Only the error's class is
 * logged, since a store's error can echo its request.
 */
export async function forgetDeploymentSecret(
  secrets: Pick<SecretStore, "delete">,
  ciphertext: string,
  record: string,
): Promise<void> {
  await secrets.delete(ciphertext, record).catch((error: unknown) => {
    getLogger().warn("deployment_secret.cleanup_failed", {
      record,
      "error.name": error instanceof Error ? error.name : typeof error,
    });
  });
}
