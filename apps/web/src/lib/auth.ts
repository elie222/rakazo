import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient, type ReactAuthClient } from "better-auth/react";

export const authClient: ReactAuthClient<{
  plugins: [ReturnType<typeof organizationClient>];
}> = createAuthClient({
  plugins: [organizationClient()],
});
