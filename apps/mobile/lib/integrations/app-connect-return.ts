import { waitForConnection } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import { rpc } from "../api/api";
import { apiBaseLoaded } from "../api/api-server";

const FINISH_ATTEMPTS = 3;
const FINISH_WITHIN_MS = 30_000;

/**
 * Finishes a catalog sign-in the in-app browser handed back to the app. The card that started it
 * reads the connection itself while it is on screen; this lands it when that card is gone, and
 * the server then updates the card and lets the bot carry on.
 */
export function finishReturnedAppConnection(link: string) {
  const query = link.split("?")[1];
  const connectionId = query ? new URLSearchParams(query).get("connection") : null;
  if (!connectionId) return;
  void bestEffort(
    "finish a returned app sign-in",
    (async () => {
      // A link that launched the app waits for its saved server and Space.
      await apiBaseLoaded();
      // A few tries, as the card makes: the provider may still be settling the account.
      await waitForConnection(connectionId, (input) => rpc("connections/complete", input), {
        signal: AbortSignal.timeout(FINISH_WITHIN_MS),
        attempts: FINISH_ATTEMPTS,
      });
    })(),
  );
}
