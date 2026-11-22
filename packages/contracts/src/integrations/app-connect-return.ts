import * as z from "zod";
import { Id } from "../ids.js";

/** The chat card a catalog connection starts from, so finishing the sign-in updates that card. */
export const AppConnectOriginSchema = z.object({
  botId: Id,
  threadId: Id,
  messageId: Id.optional(),
});
export type AppConnectOrigin = z.infer<typeof AppConnectOriginSchema>;

/** Which app starts a catalog sign-in: the mobile app, or a browser when omitted. */
export const AppConnectClientSchema = z.literal("mobile").optional();
export type AppConnectClient = z.infer<typeof AppConnectClientSchema>;

/** The web page a catalog sign-in returns to. */
export const APP_CONNECT_CALLBACK_PATH = "/integrations/callback";
/** The deep link the web callback hands a mobile app's catalog sign-in back to. */
export const MOBILE_APP_CONNECT_CALLBACK_URL = "rakazo://app-connect";

/**
 * Where the provider sends the browser once the sign-in for this connection ends. The connection
 * rides in the path, so the query stays the provider's own to append to.
 */
export function appConnectCallbackUrl(
  webOrigin: string,
  connectionId: string,
  client: AppConnectClient,
): string {
  const path = `${APP_CONNECT_CALLBACK_PATH}/${encodeURIComponent(connectionId)}`;
  return `${webOrigin}${path}${client ? `/${client}` : ""}`;
}

/** Whether a page path is a catalog sign-in's callback. */
export function isAppConnectCallbackPath(pathname: string): boolean {
  return (
    pathname === APP_CONNECT_CALLBACK_PATH || pathname.startsWith(`${APP_CONNECT_CALLBACK_PATH}/`)
  );
}

/** The connection a callback finishes, and where a sign-in the mobile app started goes back to. */
export function appConnectReturn(pathname: string): {
  connectionId: string | null;
  appUrl: string | null;
} {
  const [id, client] = pathname.slice(APP_CONNECT_CALLBACK_PATH.length + 1).split("/");
  const connectionId = id ? decodeURIComponent(id) : null;
  return {
    connectionId,
    appUrl:
      connectionId && client === "mobile"
        ? `${MOBILE_APP_CONNECT_CALLBACK_URL}?${new URLSearchParams({ connection: connectionId })}`
        : null,
  };
}
