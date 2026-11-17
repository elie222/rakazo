import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FishAudioVoiceProvider } from "./fish-audio-voice.js";

const context: AdapterContext = {
  operationId: "test-operation",
  traceId: "test-trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Fish Audio catalog pagination", () => {
  it("loads owned pages sequentially until the catalog ends", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const requests = mockCatalog(async (page, own, signal) => {
      expect(own).toBe(true);
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10, signal);
      active--;
      return {
        has_more: page < 3,
        items: [{ _id: `own-${page}`, title: `Owned ${page}` }],
      };
    });
    const voices = new FishAudioVoiceProvider().listVoices("fake-fish-key", context);

    await vi.runAllTimersAsync();

    expect((await voices).map(({ id }) => id)).toEqual(["own-1", "own-2", "own-3"]);
    expect(requests.map(({ page }) => page)).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
  });

  it("keeps the owned catalog within its twenty-page budget", async () => {
    vi.useFakeTimers();
    const requests = mockCatalog(async (page, own, signal) => {
      expect(own).toBe(true);
      await delay(10, signal);
      return { total: 1_000_000, has_more: true, items: [{ _id: `own-${page}` }] };
    });
    const voices = new FishAudioVoiceProvider().listVoices("fake-fish-key", context);

    await vi.runAllTimersAsync();

    expect(await voices).toHaveLength(20);
    expect(requests.map(({ page }) => page)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("does not request another page after a terminal first page", async () => {
    const requests = mockCatalog(() => ({
      total: 1,
      has_more: false,
      items: [{ _id: "only" }],
    }));

    expect(await new FishAudioVoiceProvider().listVoices("fake-fish-key", context)).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.own).toBe(true);
  });

  it("preserves an owned catalog account error", async () => {
    const requests = mockCatalog(() => {
      return Response.json({ detail: "Invalid API key" }, { status: 401 });
    });

    await expect(
      new FishAudioVoiceProvider().listVoices("fake-fish-key", context),
    ).rejects.toMatchObject({ code: "VOICE_KEY_REJECTED" });
    expect(requests).toHaveLength(1);
    expect(requests.every(({ signal }) => signal.aborted)).toBe(true);
  });

  it("propagates a caller abort without requesting more pages", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("caller canceled");
    const requests = mockCatalog(async (_page, own, signal) => {
      expect(own).toBe(true);
      await delay(100_000, signal);
      return { items: [] };
    });
    const outcome = new FishAudioVoiceProvider()
      .listVoices("fake-fish-key", { ...context, signal: controller.signal })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);

    controller.abort(reason);

    expect(await outcome).toBe(reason);
    expect(requests).toHaveLength(1);
    expect(requests.every(({ signal }) => signal.aborted)).toBe(true);
  });

  it("does not request any pages when already canceled", async () => {
    const controller = new AbortController();
    const reason = new Error("already canceled");
    controller.abort(reason);
    const requests = mockCatalog(() => ({ items: [] }));

    await expect(
      new FishAudioVoiceProvider().listVoices("fake-fish-key", {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(requests).toEqual([]);
  });

  it("retains the shared twenty-second listing deadline", async () => {
    vi.useFakeTimers();
    const reason = new DOMException("synthetic provider timeout", "TimeoutError");
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(20_000);
      const controller = new AbortController();
      setTimeout(() => controller.abort(reason), ms);
      return controller.signal;
    });
    const requests = mockCatalog(async (_page, _own, signal) => {
      await delay(100_000, signal);
      return { items: [] };
    });
    const outcome = new FishAudioVoiceProvider()
      .listVoices("fake-fish-key", context)
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(20_000);

    expect(await outcome).toBe(reason);
    expect(requests).toHaveLength(1);
    expect(requests.every(({ signal }) => signal.aborted)).toBe(true);
  });
});

function mockCatalog(
  reply: (page: number, own: boolean, signal: AbortSignal) => unknown | Promise<unknown>,
) {
  const requests: Array<{ page: number; own: boolean; signal: AbortSignal }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page_number"));
      const own = url.searchParams.has("self");
      const signal = init?.signal;
      if (!signal) throw new Error("Missing request signal");
      requests.push({ page, own, signal });
      const body = await reply(page, own, signal);
      return body instanceof Response ? body : Response.json(body);
    }),
  );
  return requests;
}

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

describe("Fish Audio language filter", () => {
  it("advertises catalog language support", () => {
    expect(new FishAudioVoiceProvider().describe().capabilities.languages).toBe(true);
  });

  it("keeps the account-owned catalog independent of the language filter", async () => {
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        queries.push(url.searchParams.toString());
        return Response.json({
          total: 1,
          items: [{ _id: "owned-1", title: "Owned" }],
        });
      }),
    );
    const voices = await new FishAudioVoiceProvider().listVoices("fake-fish-key", context, {
      language: "de-DE",
    });
    expect(voices.map((voice) => voice.id)).toEqual(["owned-1"]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("self=true");
    expect(queries[0]).not.toContain("language=");
  });
});
