import { createCipheriv, createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  resolveNovncTarget,
  safeProxyHeaders,
  safeProxyResponseHeaders,
  stripSensitiveHandshakeHeaders,
} from "./screen-proxy.js";

function signedPath(
  port: number,
  expiresAt: number,
  secret: string,
  rest = "/embed.html",
  hostname = "127.0.0.1",
  policy: "view" | "control" = "view",
) {
  const signature = createHmac("sha256", secret)
    .update(`${hostname}:${port}:${policy}:${expiresAt}`)
    .digest("base64url");
  const target = Buffer.from(hostname).toString("base64url");
  return `/novnc/${target}/${port}/${policy}/${expiresAt}.${signature}${rest}`;
}

function remotePath(
  expiresAt: number,
  secret: string,
  url: string,
  policy: "view" | "control" = "view",
) {
  const iv = Buffer.alloc(12, 1);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  cipher.setAAD(Buffer.from(`${policy}:${expiresAt}`));
  const ciphertext = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  return `/novnc/remote/${policy}/${expiresAt}.${token}/vnc.html`;
}

describe("noVNC proxy authorization", () => {
  it("accepts signed, unexpired loopback targets", () => {
    expect(resolveNovncTarget(signedPath(49152, 2_000, "secret"), "secret", 1_000)).toEqual({
      hostname: "127.0.0.1",
      port: 49152,
      path: "/embed.html?view_only=true",
      interactive: false,
    });
  });

  it("rejects arbitrary ports, bad signatures, and expired capabilities", () => {
    expect(resolveNovncTarget("/novnc/5432/index.html", "secret", 1_000)).toBeNull();
    expect(resolveNovncTarget(signedPath(49152, 2_000, "wrong"), "secret", 1_000)).toBeNull();
    expect(resolveNovncTarget(signedPath(49152, 999, "secret"), "secret", 1_000)).toBeNull();
  });

  it("binds server-enforced view mode while allowing required noVNC paths", () => {
    const viewOnly = signedPath(49152, 2_000, "secret", "/embed.html?view_only=true");
    expect(resolveNovncTarget(viewOnly, "secret", 1_000)?.path).toBe("/embed.html?view_only=true");
    expect(
      resolveNovncTarget(viewOnly.replace("view_only=true", "view_only=false"), "secret", 1_000),
    ).toMatchObject({ path: "/embed.html?view_only=true", interactive: false });
    expect(
      resolveNovncTarget(
        viewOnly.replace(/\/embed\.html\?view_only=true$/, "/websockify"),
        "secret",
        1_000,
      ),
    ).toMatchObject({ path: "/websockify", interactive: false });
    expect(resolveNovncTarget(viewOnly.replace("/view/", "/control/"), "secret", 1_000)).toBeNull();
    expect(resolveNovncTarget(viewOnly.replace("/49152/", "/49153/"), "secret", 1_000)).toBeNull();

    const control = signedPath(
      49153,
      2_000,
      "secret",
      "/embed.html?view_only=true",
      "127.0.0.1",
      "control",
    );
    expect(resolveNovncTarget(control, "secret", 1_000)).toMatchObject({
      path: "/embed.html?view_only=false",
      interactive: true,
    });
  });

  it("keeps encrypted external Box targets bound to their view/control policy", () => {
    const target = "https://box.example/vnc.html?token=provider-secret&view_only=true";
    const view = remotePath(2_000, "secret", target);
    expect(resolveNovncTarget(view, "secret", 1_000)).toMatchObject({
      protocol: "https:",
      hostname: "box.example",
      port: 443,
      path: "/vnc.html?token=provider-secret&view_only=true",
      interactive: false,
    });
    expect(
      resolveNovncTarget(view.replace("/vnc.html", "/vnc.html?view_only=false"), "secret", 1_000),
    ).toMatchObject({
      path: "/vnc.html?token=provider-secret&view_only=true",
      interactive: false,
    });
    expect(resolveNovncTarget(view.replace("/view/", "/control/"), "secret", 1_000)).toBeNull();
  });

  it("does not forward application credentials", () => {
    expect(
      safeProxyHeaders({
        host: "app.example",
        cookie: "session=secret",
        authorization: "Bearer secret",
        "proxy-authorization": "Basic secret",
        upgrade: "websocket",
        "sec-websocket-key": "key",
      }),
    ).toEqual({ upgrade: "websocket", "sec-websocket-key": "key" });
  });

  it("does not forward HTTP/2 pseudo-headers to the HTTP/1 upstream", () => {
    expect(
      safeProxyHeaders({
        ":method": "GET",
        ":path": "/novnc/embed.html",
        ":authority": "localhost:5173",
        ":scheme": "https",
        upgrade: "websocket",
        "sec-websocket-key": "key",
      }),
    ).toEqual({ upgrade: "websocket", "sec-websocket-key": "key" });
  });

  it("does not accept cookie or site-data mutations from a bot computer", () => {
    expect(
      safeProxyResponseHeaders({
        ":status": "200",
        "content-type": "text/html",
        "set-cookie": ["session=attacker"],
        "clear-site-data": '"cookies"',
      }),
    ).toEqual({ "content-type": "text/html" });

    const handshake = Buffer.from(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSet-Cookie: session=attacker\r\n\r\nframe",
      "latin1",
    );
    expect(stripSensitiveHandshakeHeaders(handshake)?.toString("latin1")).toBe(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\nframe",
    );
  });
});
