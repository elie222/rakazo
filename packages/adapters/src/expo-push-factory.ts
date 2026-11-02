import type { PrismaClient } from "@rakazo/db";
import { pushSessionExpiresAt, runAsSystem } from "@rakazo/db";
import type { ExpoPushOptions } from "./expo-push.js";
import { ExpoPushProvider } from "./expo-push.js";
import type { PrismaPushTokenStore, PushTokenStore } from "./push-token-store.js";

/** API and worker deliveries must carry the same account, server and device badge. */
export function createExpoPushProvider(
  prisma: Pick<PrismaClient, "user" | "session">,
  tokens: PushTokenStore & Pick<PrismaPushTokenStore, "badgeForToken">,
  options: Pick<ExpoPushOptions, "jobs" | "accessToken"> & {
    authUrl?: string;
    webOrigin?: string;
  },
): ExpoPushProvider {
  const authUrl = options.authUrl?.trim() || options.webOrigin?.trim() || "http://127.0.0.1:5173";
  const server = new URL(authUrl);
  if (server.protocol !== "http:" && server.protocol !== "https:")
    throw new Error("Push server URL must be an absolute http(s) URL");
  return new ExpoPushProvider(tokens, {
    apiBase: server.origin,
    sessionExpiresAt: (sessionId) =>
      runAsSystem("read push session expiry", () => pushSessionExpiresAt(prisma, sessionId)),
    accountLabel: (userId) =>
      runAsSystem(
        "read push account label",
        async () =>
          (await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))
            ?.email ?? userId,
      ),
    badgeForToken: (token) => tokens.badgeForToken(token),
    jobs: options.jobs,
    accessToken: options.accessToken,
  });
}
