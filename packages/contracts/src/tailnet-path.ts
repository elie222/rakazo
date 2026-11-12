/**
 * WebSocket upgrade a bot's computer opens to reach one tailnet destination, with
 * `?host=&port=` and the run's tunnel token as a Bearer credential. After the upgrade, binary
 * messages carry the TCP stream both ways. An empty binary message from the computer ends its
 * sending side (a TCP half-close); the server closes the WebSocket when the far side ends.
 *
 * Its own module, free of imports, so the web server's config can load it directly.
 */
export const TAILNET_CONNECT_PATH = "/api/tailnet/connect";
