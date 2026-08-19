import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const SCREEN_PROXY_TTL_MS = 60 * 60_000;
const SCREEN_PROXY_CIPHER = "aes-256-gcm";
const SCREEN_PROXY_REMOTE_PREFIX = "/novnc/remote";

export interface ScreenProxyOptions {
  /** Keep provider desktop secrets server-side and enforce the view/control policy in the proxy. */
  proxyExternal?: boolean;
}

export function addScreenProxyCapability(
  url: string,
  secret: string,
  proxyOrigin: string,
  now = Date.now(),
  options: ScreenProxyOptions = {},
): string {
  try {
    const parsed = new URL(url);
    if (options.proxyExternal && parsed.protocol === "https:" && parsed.hostname) {
      const expiresAt = now + SCREEN_PROXY_TTL_MS;
      const policy = parsed.searchParams.get("view_only") === "false" ? "control" : "view";
      const token = sealScreenTarget(parsed.toString(), secret, policy, expiresAt);
      const origin = new URL(proxyOrigin).origin;
      return `${origin}${SCREEN_PROXY_REMOTE_PREFIX}/${policy}/${expiresAt}.${token}${parsed.pathname || "/"}`;
    }
    if (parsed.protocol !== "http:" || !parsed.hostname || !parsed.port) return url;
    const expiresAt = now + SCREEN_PROXY_TTL_MS;
    const target = Buffer.from(parsed.hostname).toString("base64url");
    const policy = parsed.searchParams.get("view_only") === "false" ? "control" : "view";
    const destination = `${parsed.pathname}${parsed.search}`;
    const signature = createHmac("sha256", secret)
      .update(`${parsed.hostname}:${parsed.port}:${policy}:${expiresAt}`)
      .digest("base64url");
    const origin = new URL(proxyOrigin).origin;
    return `${origin}/novnc/${target}/${parsed.port}/${policy}/${expiresAt}.${signature}${destination}`;
  } catch {
    return url;
  }
}

function sealScreenTarget(
  url: string,
  secret: string,
  policy: "view" | "control",
  expiresAt: number,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(SCREEN_PROXY_CIPHER, screenProxyKey(secret), iv);
  cipher.setAAD(Buffer.from(`${policy}:${expiresAt}`));
  const ciphertext = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

function screenProxyKey(secret: string) {
  return createHash("sha256").update(secret).digest();
}
