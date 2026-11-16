import type { DesktopSetup } from "@rakazo/contracts";
import type { Session } from "electron";
import { serverHeadersFor } from "./setup-config.js";

/** Call only for the selected app session with nonempty, validated headers. */
export function installServerHeaders(
  value: Session,
  setup: () => DesktopSetup | null,
  appContentsId: () => number | undefined,
) {
  const names = Object.keys(setup()?.headers ?? {}).map((name) => name.toLowerCase());
  if (names.length === 0) return;
  value.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    const extra = serverHeadersFor(details.url, setup());
    const nativeRequest =
      (details.webContentsId === -1 || details.webContentsId === undefined) && !details.frame;
    // Redirects can inherit custom headers. Strip them before checking the new destination.
    for (const name of Object.keys(requestHeaders)) {
      if (names.includes(name.toLowerCase()) && !(nativeRequest && Object.keys(extra).length > 0))
        delete requestHeaders[name];
    }
    const appRequest = details.webContentsId === appContentsId() && appContentsId() !== undefined;
    const initiator = details.frame?.url;
    const trustedInitiator = !initiator || !/^(devtools|chrome-extension):/i.test(initiator);
    callback({
      requestHeaders: {
        ...requestHeaders,
        ...(appRequest && trustedInitiator ? extra : {}),
      },
    });
  });
}
