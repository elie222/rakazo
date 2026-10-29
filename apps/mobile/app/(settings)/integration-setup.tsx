import { Redirect } from "expo-router";

/** Older deep links lead to personal connections; server credentials are operator configuration. */
export default function IntegrationSetup() {
  return <Redirect href="/integrations" />;
}
