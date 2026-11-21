import type { ProductAnalytics } from "@rakazo/adapter-kit";
import { matchFeaturedConnectorId } from "@rakazo/core";

/**
 * Reports a connection turning connected. Keyed to the row and its creation, so a poll that
 * reports it again, or a reconnect that reuses the row, counts once. Only an app from the fixed
 * catalog is named.
 */
export function recordToolConnected(
  analytics: ProductAnalytics | undefined,
  userId: string,
  connection: { id: string; provider: string; createdAt: Date },
): void {
  if (!analytics) return;
  const app = matchFeaturedConnectorId(connection.provider);
  analytics.capture(
    userId,
    { name: "tool_connected", ...(app ? { app } : {}) },
    { id: connection.id, at: connection.createdAt },
  );
}
