import { describe, expect, it, vi } from "vitest";
import { assertSafeWebUrl, fetchSafeWebText, isBlockedHostname } from "./web-ssrf.js";

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

describe("web SSRF policy", () => {
  it.each([
    "http://localhost/x",
    "https://127.0.0.1/x",
    "http://10.0.0.1/x",
    "https://192.168.1.1/x",
    "http://169.254.169.254/latest/meta-data",
    "https://[::1]/",
    "http://[::]/",
    "file:///etc/passwd",
    "gopher://example.test/1",
    "ftp://example.test/file",
  ])("rejects unsafe URL %s", async (url) => {
    await expect(assertSafeWebUrl(url, publicResolver)).rejects.toThrow();
  });

  it("accepts public http and https URLs", async () => {
    await expect(assertSafeWebUrl("https://example.test/page", publicResolver)).resolves.toEqual(
      new URL("https://example.test/page"),
    );
    await expect(assertSafeWebUrl("http://example.test/page", publicResolver)).resolves.toEqual(
      new URL("http://example.test/page"),
    );
  });

  it("rejects hosts that resolve privately", async () => {
    await expect(
      assertSafeWebUrl("https://example.test/page", async () => [
        { address: "10.1.2.3", family: 4 as const },
      ]),
    ).rejects.toThrow(/private address/i);
  });

  it("blocks private hostnames before DNS", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("127.0.0.1")).toBe(true);
    expect(isBlockedHostname("10.2.3.4")).toBe(true);
    expect(isBlockedHostname("192.168.0.9")).toBe(true);
    expect(isBlockedHostname("169.254.1.1")).toBe(true);
    expect(isBlockedHostname("::1")).toBe(true);
    expect(isBlockedHostname("example.test")).toBe(false);
  });

  it("re-validates redirect targets and blocks redirect-to-private", async () => {
    const fetchMock: typeof fetch = async (input) => {
      const href = String(input);
      if (href === "https://example.test/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/secret" },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    await expect(
      fetchSafeWebText("https://example.test/start", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
      }),
    ).rejects.toThrow(/private|internal/i);
  });

  it("follows a public redirect and returns the final body", async () => {
    const fetchMock: typeof fetch = async (input) => {
      const href = String(input);
      if (href === "https://example.test/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.test/final" },
        });
      }
      if (href === "https://example.test/final") {
        return new Response("<html><title>Ok</title><body>hello</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const result = await fetchSafeWebText("https://example.test/start", {
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    expect(result.url).toBe("https://example.test/final");
    expect(result.body).toContain("hello");
  });

  it("drops caller-provided headers on cross-origin redirects", async () => {
    let finalHeaders = new Headers();
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === "https://example.test") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example.test/final" },
        });
      }
      finalHeaders = new Headers(init?.headers);
      return new Response("ok", { status: 200 });
    };

    await fetchSafeWebText("https://example.test/start", {
      fetch: fetchMock,
      resolveHostname: publicResolver,
      headers: {
        Authorization: "Bearer stored",
        "X-Api-Key": "stored-key",
        "X-Trace-Id": "trace-1",
      },
    });

    expect(finalHeaders.get("authorization")).toBeNull();
    expect(finalHeaders.get("x-api-key")).toBeNull();
    expect(finalHeaders.get("x-trace-id")).toBeNull();
  });

  it("rejects oversized Content-Length before reading", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response("ignored", {
        status: 200,
        headers: { "content-length": String(10 * 1024 * 1024) },
      });
    await expect(
      fetchSafeWebText("https://example.test/big", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("aborts while streaming once maxBytes is exceeded", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600).fill(65));
        controller.enqueue(new Uint8Array(600).fill(66));
        controller.close();
      },
    });
    const fetchMock: typeof fetch = async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });

    await expect(
      fetchSafeWebText("https://example.test/stream", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        maxBytes: 1000,
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("readBodyCapped stops once the byte budget is exceeded", async () => {
    const { readBodyCapped } = await import("./web-ssrf.js");
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(400).fill(1));
          return;
        }
        if (pulls === 2) {
          controller.enqueue(new Uint8Array(400).fill(2));
          return;
        }
        controller.enqueue(new Uint8Array(400).fill(3));
        controller.close();
      },
    });
    const response = new Response(stream, { status: 200 });
    await expect(readBodyCapped(response, 500)).rejects.toThrow(/too large/i);
    // Second chunk already exceeds; a third pull must not be needed.
    expect(pulls).toBeLessThanOrEqual(2);
  });

  it("readBodyCapped does not wait for a hanging stream cancellation", async () => {
    const { readBodyCapped } = await import("./web-ssrf.js");
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(501));
        },
        cancel,
      }),
    );

    await expect(readBodyCapped(response, 500)).rejects.toThrow(/too large/i);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("accepts a streamed body that stays under maxBytes", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    });
    const fetchMock: typeof fetch = async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    const result = await fetchSafeWebText("https://example.test/ok", {
      fetch: fetchMock,
      resolveHostname: publicResolver,
      maxBytes: 100,
    });
    expect(result.body).toBe("hello world");
  });

  it("uses one deadline across the whole redirect chain", async () => {
    let hops = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      hops += 1;
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 80);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      });
      const href = String(input);
      if (href.endsWith("/a")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.test/b" },
        });
      }
      if (href.endsWith("/b")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.test/c" },
        });
      }
      return new Response("done", { status: 200 });
    };

    await expect(
      fetchSafeWebText("https://example.test/a", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        timeoutMs: 100,
      }),
    ).rejects.toThrow();
    // Per-hop 100ms would allow all three hops; one shared deadline stops earlier.
    expect(hops).toBeLessThan(3);
  });

  it("cancels redirect response bodies before following the next hop", async () => {
    let cancelled = false;
    const redirectBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("redirect-body"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock: typeof fetch = async (input) => {
      const href = String(input);
      if (href.endsWith("/start")) {
        return new Response(redirectBody, {
          status: 302,
          headers: { location: "https://example.test/final" },
        });
      }
      return new Response("ok", { status: 200 });
    };

    const result = await fetchSafeWebText("https://example.test/start", {
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    expect(result.body).toBe("ok");
    expect(cancelled).toBe(true);
  });

  it("aborts a hanging response body under the shared deadline", async () => {
    const hangingBody = new ReadableStream<Uint8Array>({
      start() {
        // never enqueues or closes — simulates a fetch body that ignores abort
      },
    });
    const fetchMock: typeof fetch = async () =>
      new Response(hangingBody, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });

    let destroyed = false;
    const started = Date.now();
    await expect(
      fetchSafeWebText("https://example.test/hang", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        timeoutMs: 40,
        destroy: () => {
          destroyed = true;
        },
      }),
    ).rejects.toThrow();
    expect(destroyed).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("aborts when fetch itself ignores the abort signal", async () => {
    const fetchMock: typeof fetch = async () =>
      new Promise(() => {
        // never settles — ignores init.signal
      });

    let destroyed = false;
    const started = Date.now();
    await expect(
      fetchSafeWebText("https://example.test/hang-fetch", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        timeoutMs: 40,
        destroy: () => {
          destroyed = true;
        },
      }),
    ).rejects.toThrow();
    expect(destroyed).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("finishes when the deadline fires despite hanging body cancel and close", async () => {
    let bodyCancelStarted = false;
    let cleanupStarted = false;
    const hangingBody = new ReadableStream<Uint8Array>({
      start() {
        // never enqueues or closes
      },
      cancel() {
        bodyCancelStarted = true;
        return new Promise(() => {
          // never settles
        });
      },
    });
    const fetchMock: typeof fetch = async () =>
      new Response(hangingBody, {
        status: 302,
        headers: { location: "https://example.test/next" },
      });

    let destroyed = false;
    const started = Date.now();
    await expect(
      fetchSafeWebText("https://example.test/start", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        timeoutMs: 40,
        cleanup: () => {
          cleanupStarted = true;
          return new Promise(() => {
            // hanging dispatcher.close()
          });
        },
        destroy: () => {
          destroyed = true;
        },
      }),
    ).rejects.toThrow();
    expect(bodyCancelStarted).toBe(true);
    expect(cleanupStarted).toBe(true);
    expect(destroyed).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("swallows a rejecting destroy promise without extending the deadline", async () => {
    const hangingBody = new ReadableStream<Uint8Array>({
      start() {
        // never enqueues or closes
      },
    });
    const fetchMock: typeof fetch = async () =>
      new Response(hangingBody, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });

    let destroyCalled = false;
    const started = Date.now();
    await expect(
      fetchSafeWebText("https://example.test/hang", {
        fetch: fetchMock,
        resolveHostname: publicResolver,
        timeoutMs: 40,
        destroy: () => {
          destroyCalled = true;
          return Promise.reject(new Error("destroy failed"));
        },
      }),
    ).rejects.toThrow();
    expect(destroyCalled).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("aborts stalled DNS under the shared deadline", async () => {
    let resolveCalls = 0;
    const stalledResolver = () =>
      new Promise<Array<{ address: string; family: number }>>((resolve) => {
        resolveCalls += 1;
        setTimeout(() => resolve([{ address: "203.0.113.10", family: 4 }]), 500);
      });

    await expect(
      fetchSafeWebText("https://example.test/slow-dns", {
        fetch: async () => new Response("nope", { status: 200 }),
        resolveHostname: stalledResolver,
        timeoutMs: 50,
      }),
    ).rejects.toThrow();
    expect(resolveCalls).toBe(1);
  });
});
