/** The window a chat card opens an app's sign-in in; the callback closes it when done. */
export const APP_CONNECT_WINDOW_NAME = "rakazo-app-connect";

const RETURN_KEY = "rakazo:app-connect-return:";

/**
 * Notes the chat to come back to before this tab leaves for a sign-in, because the browser
 * blocked the popup. The tab's own storage, so it outlives the trip to the provider.
 */
export function rememberAppConnectReturn(connectionId: string) {
  try {
    window.sessionStorage.setItem(
      RETURN_KEY + connectionId,
      window.location.pathname + window.location.search,
    );
  } catch {
    // Without storage the callback opens the app's home instead.
  }
}

/** Where a sign-in that left this tab comes back to, read once; null when it opened a popup. */
export function takeAppConnectReturn(connectionId: string): string | null {
  try {
    const path = window.sessionStorage.getItem(RETURN_KEY + connectionId);
    window.sessionStorage.removeItem(RETURN_KEY + connectionId);
    return path;
  } catch {
    return null;
  }
}
