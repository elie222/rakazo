import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNovncTarget, safeProxyHeaders, watchScreenAuthorization } from "./screen-proxy.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("screen proxy", () => {
  it("uses only server-provided provider credentials for both proxy transports", () => {
    expect(
      safeProxyHeaders(
        {
          cookie: "app_session=private",
          authorization: "Bearer browser",
          host: "app.example",
          upgrade: "websocket",
        },
        { cookie: "provider_auth=fake-token" },
      ),
    ).toEqual({ upgrade: "websocket", cookie: "provider_auth=fake-token" });
  });

  it("rejects legacy URLs without contacting the API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      await resolveNovncTarget("/novnc/old/view/token/embed.html", "secret", "http://api.example"),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks each request and fails closed on revocation or API failure", async () => {
    const target = {
      protocol: "http:",
      hostname: "127.0.0.1",
      port: 49152,
      path: "/websockify",
      interactive: false,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(target))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    const failures: string[] = [];
    const resolve = () =>
      resolveNovncTarget(
        "/novnc/session/view/token/websockify",
        "secret",
        "http://api.example",
        (reason) => failures.push(reason),
      );
    expect(await resolve()).toEqual(target);
    expect(await resolve()).toBeNull();
    expect(await resolve()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(failures).toEqual(["authority_rejected", "authority_unavailable"]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer secret" },
    });
  });
  it("fails closed for a malformed authority response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ hostname: "screen.example", port: "443" })),
    );
    const onFailure = vi.fn();
    expect(
      await resolveNovncTarget(
        "/novnc/session/view/token/vnc.html",
        "secret",
        "http://api.example",
        onFailure,
      ),
    ).toBeNull();
    expect(onFailure).toHaveBeenCalledWith("invalid_authority_response");
  });
  it("reports invalid JSON as an invalid authority response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));
    const onFailure = vi.fn();
    expect(
      await resolveNovncTarget(
        "/novnc/session/view/token/vnc.html",
        "secret",
        "http://api.example",
        onFailure,
      ),
    ).toBeNull();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith("invalid_authority_response");
  });
  it("reports a dropped authority body as unavailable", async () => {
    const response = new Response("{}", { status: 200 });
    vi.spyOn(response, "json").mockRejectedValueOnce(new Error("aborted"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const onFailure = vi.fn();
    expect(
      await resolveNovncTarget(
        "/novnc/session/view/token/vnc.html",
        "secret",
        "http://api.example",
        onFailure,
      ),
    ).toBeNull();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith("authority_unavailable");
  });

  it("closes an active stream on revocation and stops checking closed streams", async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const revoke = vi.fn();
    watchScreenAuthorization(check, revoke);
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(check).toHaveBeenCalledTimes(2);
    const stop = watchScreenAuthorization(check, revoke);
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(check).toHaveBeenCalledTimes(2);
  });
  it("closes a stream when authorization fails unexpectedly", async () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    watchScreenAuthorization(async () => {
      throw new Error("unavailable");
    }, revoke);
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoke).toHaveBeenCalledTimes(1);
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
});
