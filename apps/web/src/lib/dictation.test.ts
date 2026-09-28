import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  combineTranscript,
  Dictation,
  MAX_TRANSCRIPTION_RESPONSE_BYTES,
  TRANSCRIPTION_RESPONSE_TIMEOUT_MS,
  webSpeechAvailable,
  webSpeechNeedsServerFallback,
} from "./dictation.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function stubRecorderFallback(fetchMock: ReturnType<typeof vi.fn>) {
  const track = { stop: vi.fn() };
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
    },
    language: "en-US",
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "MediaRecorder",
    class {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    },
  );
}

describe("Dictation recorder fallback", () => {
  it("stops tracks if hold-to-talk is cancelled while the mic prompt is open", async () => {
    const track = { stop: vi.fn() };
    let grant!: (stream: { getTracks: () => Array<{ stop: () => void }> }) => void;
    const pending = new Promise<{ getTracks: () => Array<{ stop: () => void }> }>((resolve) => {
      grant = resolve;
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => pending) },
      language: "en-US",
    });
    const started = vi.fn();
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        start() {
          started();
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
        }
      },
    );

    const dictation = new Dictation();
    const listening = dictation.listen({
      mode: "hold",
      transcribe: true,
      onFinal: () => undefined,
    });
    dictation.stop("cancel");
    grant({ getTracks: () => [track] });
    await listening;

    expect(track.stop).toHaveBeenCalledOnce();
    expect(started).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("idle");
  });

  it("does not deliver a stale transcript to a newer session", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });

    let transcribe!: (body: { text: string }) => void;
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
          );
          transcribe = (body) => resolve(Response.json(body));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const first = vi.fn();
    const second = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: first });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: second });
    transcribe({ text: "stale take" });
    await Promise.resolve();
    await Promise.resolve();

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("listening");
  });

  it("keeps line breaks in a server transcript with no speech prefix", async () => {
    const fetchMock = vi.fn(async () => Response.json({ text: "  line one\n\nline two  " }));
    stubRecorderFallback(fetchMock);
    const onFinal = vi.fn();
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    dictation.submitHold();

    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("line one\n\nline two"));
  });

  it("keeps transcription in the space where recording started", async () => {
    const store = new Map<string, string>([["rakazo:space-id", "space-support"]]);
    const localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ text: "hello" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    store.set("rakazo:space-id", "space-other");
    dictation.submitHold();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("hello"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/transcribe",
      expect.objectContaining({ credentials: "include" }),
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-rakazo-space-id")).toBe("space-support");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("rejects oversized transcription responses without waiting for cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetchMock = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-length": String(MAX_TRANSCRIPTION_RESPONSE_BYTES + 1) },
        }),
    );
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();

    await vi.waitFor(() =>
      expect(dictation.state.error).toBe("Transcription response is too large."),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("times out while a transcription response body is stalled", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull: () => new Promise<void>(() => undefined),
          }),
        ),
    );
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_RESPONSE_TIMEOUT_MS);

    expect(dictation.state.error).toBe("Transcription request timed out.");
  });

  it("surfaces timeout when fetch rejects with AbortError", async () => {
    // Browsers reject aborted fetch with DOMException AbortError. Matching token
    // means the deadline fired (stop() bumps token first), so this must not stay
    // stuck on "transcribing".
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();

    await vi.waitFor(() => expect(dictation.state.error).toBe("Transcription request timed out."));
    expect(dictation.state.status).toBe("idle");
  });

  it("stays silent when stop cancels an in-flight transcription", async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(dictation.state.status).toBe("transcribing");

    dictation.stop("cancel");
    await Promise.resolve();
    await Promise.resolve();

    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toBeUndefined();
  });

  it("ignores leftover audio from a replaced recorder", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) =>
      Response.json({ text: "ok" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const recorders: Array<{
      ondataavailable: ((event: { data: Blob }) => void) | null;
      onstop: (() => void) | null;
      stop: () => void;
    }> = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["new"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    recorders[0]?.ondataavailable?.({
      data: new Blob(["STALE-AUDIO-DATA"], { type: "audio/webm" }),
    });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "")) as {
      audioBase64: string;
    };
    const decoded = atob(body.audioBase64);
    expect(decoded).toContain("new");
    expect(decoded).not.toContain("STALE");
  });

  it("returns to idle when the recorder cannot start", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    vi.stubGlobal(
      "MediaRecorder",
      class {
        start() {
          throw new Error("recorder unavailable");
        }
      },
    );

    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });

    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toBe("recorder unavailable");
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("fails visibly when endpoint dictation has no silence detector", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const started = vi.fn();
    vi.stubGlobal(
      "MediaRecorder",
      class {
        start() {
          started();
        }
      },
    );

    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      onFinal: () => undefined,
    });
    expect(started).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(dictation.state.error).toMatch(/stop talking/i);
  });

  it("stops an endpoint recording after silence", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const level = { current: 0.6 };
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(Math.round(128 + level.current * 127));
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
      resume() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);

    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "hello" }));
    vi.stubGlobal("fetch", fetchMock);

    const onFinal = vi.fn();
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    expect(dictation.state.status).toBe("listening");
    await vi.advanceTimersByTimeAsync(80);
    level.current = 0;
    await vi.advanceTimersByTimeAsync(240);
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("hello"));
    vi.useRealTimers();
  });

  it("does not let a replaced recorder tear down the new silence detector", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const level = { current: 0.6 };
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(Math.round(128 + level.current * 127));
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
      resume() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);

    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "later" }));
    vi.stubGlobal("fetch", fetchMock);

    const recorders: Array<{
      onstop: (() => void) | null;
      stop: () => void;
    }> = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    const staleStop = recorders[0]?.onstop;
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    staleStop?.();
    await vi.advanceTimersByTimeAsync(80);
    level.current = 0;
    await vi.advanceTimersByTimeAsync(240);
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("later"));
    vi.useRealTimers();
  });
});

describe("combineTranscript", () => {
  it("joins a short prefix that is not a whole word in the server text", () => {
    expect(combineTranscript("we", "welcome")).toBe("we welcome");
  });

  it("does not repeat a word when the server transcript adds a comma", () => {
    expect(combineTranscript("hello", "hello, world")).toBe("hello, world");
    expect(combineTranscript("hello", "Hello, world")).toBe("Hello, world");
  });

  it.each([
    ["hello."],
    ["hello!"],
    ["hello?"],
    ["hello; world"],
    ["hello: world"],
    ["hello's world"],
    ["hello-world"],
    ["hello)"],
    ['hello"'],
    ["hello，world"],
  ])("treats punctuation after the retained word as a boundary (%s)", (serverText) => {
    expect(combineTranscript("hello", serverText)).toBe(serverText);
  });

  it("keeps the server transcript when whitespace follows the retained words", () => {
    expect(combineTranscript("call me later", "Call me later and goodbye")).toBe(
      "Call me later and goodbye",
    );
  });

  it("still joins when the server text continues the retained token", () => {
    expect(combineTranscript("hello", "helloworld")).toBe("hello helloworld");
    expect(combineTranscript("hello", "hello2")).toBe("hello hello2");
    expect(combineTranscript("hello", "hello_world")).toBe("hello hello_world");
    expect(combineTranscript("na", "naïve")).toBe("na naïve");
    expect(combineTranscript("a", "a𐐀")).toBe("a a𐐀");
    expect(combineTranscript("a𐐀", "a𐐀 more")).toBe("a𐐀 more");
  });
});

describe("dictation engine choice", () => {
  it("uses Web Speech when the browser implements it", () => {
    vi.stubGlobal("window", { SpeechRecognition: class {} });
    expect(webSpeechAvailable()).toBe(true);
  });

  it("treats Electron as having no usable Web Speech", () => {
    vi.stubGlobal("window", {
      webkitSpeechRecognition: class {},
      rakazoDesktop: { platform: "darwin" },
    });
    expect(webSpeechAvailable()).toBe(false);
  });

  it("treats an Electron user agent as having no usable Web Speech", () => {
    vi.stubGlobal("window", { webkitSpeechRecognition: class {} });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Electron/44.2.0" });
    expect(webSpeechAvailable()).toBe(false);
  });

  it("falls back only for service failures when transcription is connected", () => {
    expect(webSpeechNeedsServerFallback("network", true)).toBe(true);
    expect(webSpeechNeedsServerFallback("service-not-allowed", true)).toBe(true);
    expect(webSpeechNeedsServerFallback("network", false)).toBe(false);
    expect(webSpeechNeedsServerFallback("not-allowed", true)).toBe(false);
    expect(webSpeechNeedsServerFallback("aborted", true)).toBe(false);
    expect(webSpeechNeedsServerFallback(undefined, true)).toBe(false);
  });
});

describe("Dictation web speech", () => {
  class FakeRecognition {
    continuous = false;
    interimResults = false;
    lang = "";
    onresult: ((event: unknown) => void) | null = null;
    onerror: ((event: { error?: string }) => void) | null = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();
    constructor() {
      instances.push(this);
    }
  }
  let instances: FakeRecognition[] = [];

  beforeEach(() => {
    instances = [];
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    vi.stubGlobal("navigator", { language: "en-US" });
  });

  type Part = string | { transcript: string; isFinal: true };

  /** One onresult carrying the whole session so far, the way Chrome reports it. */
  function said(rec: FakeRecognition | undefined, ...parts: Part[]) {
    rec?.onresult?.({
      resultIndex: 0,
      results: parts.map((part) => {
        const { transcript, isFinal } =
          typeof part === "string" ? { transcript: part, isFinal: false } : part;
        return Object.assign([{ transcript }], { isFinal });
      }),
    });
  }

  /** Chrome flips a result to final at its own phrase boundary, mid-sentence. */
  function done(transcript: string): Part {
    return { transcript, isFinal: true };
  }

  it("rides out a pause in the middle of a sentence", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal });
    const rec = instances[0];
    expect(rec?.continuous).toBe(true);
    expect(rec?.interimResults).toBe(true);

    said(rec, "okay it is based on");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(onFinal).not.toHaveBeenCalled();

    said(rec, "okay it is based on", " the new project");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(onFinal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("okay it is based on the new project");
  });

  it("keeps the window open when Chrome finalises words it already reported", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal });
    const rec = instances[0];

    said(rec, "okay tell me");
    await vi.advanceTimersByTimeAsync(400);
    // Chrome's phrase boundary: the same words again, this time final. The caller only
    // took a breath, so the quiet gap starts here, not at the first guess at the phrase.
    said(rec, done("okay tell me"));
    await vi.advanceTimersByTimeAsync(900);
    expect(onFinal).not.toHaveBeenCalled();

    said(rec, done("okay tell me"), " about the projects");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(onFinal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("okay tell me about the projects");
  });

  it("never ends the turn because the browser ended the session", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal });
    const rec = instances[0];

    said(rec, "one of the new projects");
    rec?.onend?.();
    expect(onFinal).not.toHaveBeenCalled();
    expect(rec?.start).toHaveBeenCalledTimes(2);

    // The restarted session numbers its results from zero; the earlier words survive.
    said(rec, "and the deadlines");
    await vi.advanceTimersByTimeAsync(1_200);
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("one of the new projects and the deadlines");
  });

  it("publishes interim words to watchers long before the turn ends", async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const dictation = new Dictation();
    const seen: string[] = [];
    dictation.subscribe((snapshot) => seen.push(snapshot.transcript));
    await dictation.listen({ mode: "endpoint", onFinal });

    said(instances[0], "what about the deploy");
    await vi.advanceTimersByTimeAsync(300);

    // The only signal available while the caller is still talking.
    expect(seen.at(-1)).toBe("what about the deploy");
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("restarts endpoint recognition after a quiet end", async () => {
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal: () => undefined });
    const rec = instances[0];
    expect(rec?.start).toHaveBeenCalledOnce();
    rec?.onend?.();
    expect(rec?.start).toHaveBeenCalledTimes(2);
    expect(dictation.state.status).toBe("listening");
  });

  it("records through the connected voice provider in Electron", async () => {
    const constructed = vi.fn();
    class FakeRecognition {
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        constructed();
      }
    }
    vi.stubGlobal("window", {
      webkitSpeechRecognition: FakeRecognition,
      rakazoDesktop: { platform: "darwin" },
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "from fish" }));
    stubRecorderFallback(fetchMock);

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    expect(constructed).not.toHaveBeenCalled();
    expect(dictation.state.error).toBeUndefined();
    expect(dictation.state.status).toBe("listening");
    dictation.submitHold();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("from fish"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/transcribe",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each(["network", "service-not-allowed"])(
    "falls back to server transcription when Web Speech fails with %s",
    async (error) => {
      const instances: Array<{
        onerror: ((event: { error?: string }) => void) | null;
        onend: (() => void) | null;
        start: ReturnType<typeof vi.fn>;
        abort: ReturnType<typeof vi.fn>;
      }> = [];
      class FakeRecognition {
        continuous = false;
        interimResults = false;
        lang = "";
        onresult: ((event: unknown) => void) | null = null;
        onerror: ((event: { error?: string }) => void) | null = null;
        onend: (() => void) | null = null;
        start = vi.fn();
        stop = vi.fn();
        abort = vi.fn(() => {
          this.onerror?.({ error: "aborted" });
          this.onend?.();
        });
        constructor() {
          instances.push(this);
        }
      }
      vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
      const fetchMock = vi.fn(async () => Response.json({ text: "from server" }));
      let markRecording: () => void = () => undefined;
      const recording = new Promise<void>((resolve) => {
        markRecording = resolve;
      });
      const track = { stop: vi.fn() };
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
        },
        language: "en-US",
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal(
        "MediaRecorder",
        class {
          state = "inactive";
          ondataavailable: ((event: { data: Blob }) => void) | null = null;
          onstop: (() => void) | null = null;
          start() {
            this.state = "recording";
            markRecording();
          }
          stop() {
            this.state = "inactive";
            this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
            this.onstop?.();
          }
        },
      );

      const onFinal = vi.fn();
      const dictation = new Dictation();
      await dictation.listen({ mode: "hold", transcribe: true, onFinal });
      const rec = instances[0];
      expect(rec?.start).toHaveBeenCalledOnce();
      const onend = rec?.onend;
      rec?.onerror?.({ error });
      onend?.();
      await recording;
      expect(dictation.state.error).toBeUndefined();
      expect(dictation.state.status).toBe("listening");
      expect(rec?.abort).toHaveBeenCalledOnce();
      dictation.submitHold();
      await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("from server"));
      expect(onFinal).toHaveBeenCalledOnce();
    },
  );

  it("continues an endpoint turn and joins speech heard before Web Speech failed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const level = { current: 0.6 };
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(Math.round(128 + level.current * 127));
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
      resume() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);

    type ResultEvent = {
      resultIndex: number;
      results: ArrayLike<ArrayLike<{ transcript: string }>>;
    };
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: ResultEvent) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    let markRecording: () => void = () => undefined;
    const recording = new Promise<void>((resolve) => {
      markRecording = resolve;
    });
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "  from   server " }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
          markRecording();
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
          this.onstop?.();
        }
      },
    );

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    const rec = instances[0];
    const onend = rec?.onend;
    rec?.onresult?.({
      resultIndex: 0,
      results: [[{ transcript: "call me later" }]],
    });
    rec?.onerror?.({ error: "network" });
    onend?.();
    await recording;

    expect(onFinal).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("listening");
    expect(dictation.state.transcript).toBe("call me later");
    expect(dictation.state.error).toBeUndefined();
    expect(rec?.abort).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(80);
    level.current = 0;
    await vi.advanceTimersByTimeAsync(240);
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("call me later from server"));
    expect(onFinal).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("submits retained speech when the microphone fails after fallback", async () => {
    type ResultEvent = {
      resultIndex: number;
      results: ArrayLike<ArrayLike<{ transcript: string }>>;
    };
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: ResultEvent) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw new Error("Microphone denied");
        }),
      },
      language: "en-US",
    });

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", transcribe: true, onFinal });
    const rec = instances[0];
    rec?.onresult?.({
      resultIndex: 0,
      results: [[{ transcript: "call me later" }]],
    });
    rec?.onerror?.({ error: "service-not-allowed" });

    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("call me later"));
    expect(onFinal).toHaveBeenCalledOnce();
    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toBeUndefined();
  });

  it("submits retained speech when transcription fails after fallback", async () => {
    type ResultEvent = {
      resultIndex: number;
      results: ArrayLike<ArrayLike<{ transcript: string }>>;
    };
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: ResultEvent) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    let markRecording: () => void = () => undefined;
    const recording = new Promise<void>((resolve) => {
      markRecording = resolve;
    });
    const fetchMock = vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 }));
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
          markRecording();
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
          this.onstop?.();
        }
      },
    );

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    const rec = instances[0];
    rec?.onresult?.({
      resultIndex: 0,
      results: [[{ transcript: "call me later" }]],
    });
    rec?.onerror?.({ error: "network" });
    await recording;
    expect(onFinal).not.toHaveBeenCalled();
    dictation.submitHold();

    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("call me later"));
    expect(onFinal).toHaveBeenCalledOnce();
    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not repeat server text that already starts with the retained speech", async () => {
    type ResultEvent = {
      resultIndex: number;
      results: ArrayLike<ArrayLike<{ transcript: string }>>;
    };
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: ResultEvent) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    let markRecording: () => void = () => undefined;
    const recording = new Promise<void>((resolve) => {
      markRecording = resolve;
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "  Call me later and goodbye  " }));
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
          markRecording();
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
          this.onstop?.();
        }
      },
    );

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    instances[0]?.onresult?.({
      resultIndex: 0,
      results: [[{ transcript: "call me later" }]],
    });
    instances[0]?.onerror?.({ error: "network" });
    await recording;
    dictation.submitHold();

    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("Call me later and goodbye"));
    expect(onFinal).toHaveBeenCalledOnce();
  });

  it("stops an endpoint fallback on silence without new microphone energy", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(128);
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
      resume() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);

    type ResultEvent = {
      resultIndex: number;
      results: ArrayLike<ArrayLike<{ transcript: string }>>;
    };
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: ResultEvent) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    let markRecording: () => void = () => undefined;
    const recording = new Promise<void>((resolve) => {
      markRecording = resolve;
    });
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "still there" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
          markRecording();
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
          this.onstop?.();
        }
      },
    );

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    instances[0]?.onresult?.({
      resultIndex: 0,
      results: [[{ transcript: "call me later" }]],
    });
    instances[0]?.onerror?.({ error: "network" });
    await recording;

    expect(onFinal).not.toHaveBeenCalled();
    expect(dictation.state.transcript).toBe("call me later");
    await vi.advanceTimersByTimeAsync(80);
    expect(onFinal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(160);
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("call me later still there"));
    expect(onFinal).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps a Web Speech permission error when no server fallback applies", async () => {
    const instances: Array<{
      onerror: ((event: { error?: string }) => void) | null;
    }> = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    vi.stubGlobal("navigator", { language: "en-US" });
    const started = vi.fn();
    vi.stubGlobal(
      "MediaRecorder",
      class {
        start() {
          started();
        }
      },
    );

    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    instances[0]?.onerror?.({ error: "not-allowed" });
    expect(dictation.state.error).toBe("Dictation failed: not-allowed");
    expect(started).not.toHaveBeenCalled();

    const offline = new Dictation();
    await offline.listen({ mode: "hold", onFinal: () => undefined });
    instances[1]?.onerror?.({ error: "network" });
    expect(offline.state.error).toBe("Dictation failed: network");
    expect(started).not.toHaveBeenCalled();
  });
});
