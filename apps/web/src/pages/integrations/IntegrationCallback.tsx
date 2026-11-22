import { Trans } from "@lingui/react/macro";
import { appConnectReturn } from "@rakazo/contracts";
import { waitForConnection } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import { useEffect } from "react";
import { APP_CONNECT_WINDOW_NAME, takeAppConnectReturn } from "../../lib/integrations/app-connect";
import { rpc } from "../../lib/query/rpc";

/** A few tries, so a provider that is a moment late to report the account still connects. */
const FINISH_ATTEMPTS = 5;

/**
 * Where an app's sign-in comes back to. It finishes the connection here, which also updates the
 * chat card it started from, then closes the popup or returns this tab to that chat.
 */
export function IntegrationCallbackPage() {
  useEffect(() => {
    const { connectionId, appUrl } = appConnectReturn(window.location.pathname);
    // The mobile app finishes its own sign-ins, and this browser is often not signed in.
    if (appUrl) {
      window.location.replace(appUrl);
      return;
    }
    if (!connectionId) {
      window.close();
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      // Signed out here, it only closes: the app reads the connection when it is back in front.
      await bestEffort(
        "finish an app sign-in",
        waitForConnection(connectionId, (input) => rpc.connections.complete(input, { signal }), {
          signal,
          attempts: FINISH_ATTEMPTS,
        }),
      );
      if (signal.aborted) return;
      const back =
        window.name === APP_CONNECT_WINDOW_NAME ? null : takeAppConnectReturn(connectionId);
      if (back) window.location.replace(back);
      else window.close();
    })();
    return () => controller.abort();
  }, []);

  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-center text-muted-foreground">
      <p>
        <Trans>You can close this window.</Trans>
      </p>
    </div>
  );
}
