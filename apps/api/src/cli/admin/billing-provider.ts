import type { BillingProvider } from "@rakazo/adapter-kit";
import { StripeBillingProvider, stripeBillingConfigFromEnv } from "@rakazo/adapters";
import type { AppEnv } from "../../env.js";

export function adminBillingProvider(env: AppEnv): BillingProvider | undefined {
  const config = stripeBillingConfigFromEnv(env);
  return config ? new StripeBillingProvider(config) : undefined;
}
