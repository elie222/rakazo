import type { KeyProvider } from "@rakazo/adapter-kit";
import {
  LocalKeyProvider,
  lazyKeyProvider,
  masterKeysFromEnv,
  withLocalMasterKeys,
} from "@rakazo/db";
import { AwsKmsKeyProvider, awsKmsConfigFromEnv } from "./aws-kms-key-provider.js";

/**
 * `MASTER_KEY_PROVIDER` picks who wraps space keys. Undefined keeps createDb's default,
 * the local master keys. A key manager wraps new keys while local ones keep unwrapping.
 */
export function contentKeyProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KeyProvider | undefined {
  const provider = env.MASTER_KEY_PROVIDER?.trim() || "local";
  if (provider === "local") return undefined;
  if (provider !== "aws-kms") throw new Error("Unsupported MASTER_KEY_PROVIDER");
  // Configuration errors surface at startup; local master keys are read on first use.
  const external = new AwsKmsKeyProvider(awsKmsConfigFromEnv(env));
  return lazyKeyProvider(() =>
    withLocalMasterKeys(external, new LocalKeyProvider(masterKeysFromEnv(env))),
  );
}
