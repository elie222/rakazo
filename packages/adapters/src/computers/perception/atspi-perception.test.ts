import type { AdapterContext, ComputerObservation, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { AtspiPerceptionHost } from "./atspi-perception.js";
import { AtspiPerception } from "./atspi-perception.js";

const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

const computer: ComputerRef = {
  id: "computer",
  botId: "bot",
  kind: "docker",
  providerRef: "provider",
};

const observation: ComputerObservation = {
  frameId: "frame-1",
  capturedAt: "2026-01-01T00:00:00.000Z",
  mimeType: "image/png",
  image: PNG,
  width: 1280,
  height: 800,
};

function context(signal = new AbortController().signal): AdapterContext {
  return {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal,
  };
}

function host(response: (request: Record<string, unknown>) => unknown) {
  const requests: Record<string, unknown>[] = [];
  const runWithInput = vi.fn(
    async (
      _computer: ComputerRef,
      _command: string,
      input: string,
      _timeoutMs: number,
      _context: AdapterContext,
    ) => {
      const request = JSON.parse(input) as Record<string, unknown>;
      requests.push(request);
      return { code: 0, stdout: JSON.stringify(response(request)) };
    },
  );
  return { runWithInput, requests } satisfies AtspiPerceptionHost & {
    requests: Record<string, unknown>[];
  };
}

function perception(
  hostValue: AtspiPerceptionHost,
  overrides: Partial<ConstructorParameters<typeof AtspiPerception>[1]> = {},
) {
  return new AtspiPerception(hostValue, {
    display: async () => ":1",
    observe: async () => observation,
    ...overrides,
  });
}

describe("AtspiPerception", () => {
  it("finds elements and sends the display with the request", async () => {
    const element = {
      point: { x: 50, y: 30 },
      bbox: { x: 0, y: 0, w: 100, h: 40 },
      source: "ax",
      role: "button",
      name: "Save",
    };
    const fake = host(() => ({ ok: true, elements: [element], truncated: false }));

    await expect(
      perception(fake).find(computer, { text: "Save", role: "button" }, context()),
    ).resolves.toEqual({ ok: true, elements: [element], truncated: false });
    expect(fake.requests[0]).toMatchObject({
      cmd: "find",
      display: ":1",
      text: "Save",
      role: "button",
    });
  });

  it("returns unknown for an unavailable helper, a failed command or a timed-out lookup", async () => {
    await expect(perception({}).find(computer, { text: "Save" }, context())).resolves.toEqual({
      elements: [],
      truncated: false,
      unknown: true,
    });

    const failed = host(() => ({ ok: false, error: "boom" }));
    await expect(perception(failed).find(computer, { text: "Save" }, context())).resolves.toEqual({
      elements: [],
      truncated: false,
      unknown: true,
    });

    const timedOut = host(() => ({ ok: true, unknown: true }));
    await expect(perception(timedOut).find(computer, { text: "Save" }, context())).resolves.toEqual(
      { elements: [], truncated: false, unknown: true },
    );
  });

  it("returns the element at a point and the focused element", async () => {
    const element = {
      point: { x: 10, y: 20 },
      bbox: { x: 0, y: 0, w: 20, h: 40 },
      source: "ax",
      role: "textbox",
      name: "Search",
    };
    const fake = host((request) =>
      request.cmd === "at" ? { ok: true, element } : { ok: true, element },
    );

    await expect(perception(fake).hitTest(computer, { x: 10, y: 20 }, context())).resolves.toEqual(
      element,
    );
    await expect(perception(fake).focused(computer, context())).resolves.toEqual(element);
  });

  it("returns conservative capabilities when the helper is unavailable", async () => {
    await expect(
      perception(
        {},
        { screen: async () => ({ width: 1920, height: 1080, scale: 2 }) },
      ).capabilities(computer, context()),
    ).resolves.toMatchObject({
      display: { width: 1920, height: 1080, scale: 2 },
      perception: { atspi: false, cdp: true },
    });
  });

  it("settles only after the screen has been quiet for the first window", async () => {
    const frames = [
      { ...observation, frameId: "frame-1" },
      { ...observation, frameId: "frame-2" },
      { ...observation, frameId: "frame-2" },
    ];
    let index = 0;
    let now = 0;
    const result = await perception(
      {},
      {
        observe: async () => frames[Math.min(index++, frames.length - 1)]!,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    ).settle(computer, { quietMs: 100, firstMs: 150, timeoutMs: 1_000 }, context());

    expect(result).toEqual({
      changed: [],
      lastChangeMono: 100,
      quiet: true,
      noVisibleChange: false,
    });
  });

  it("zooms the last observation and refuses a stale frame", async () => {
    const finding = perception({});
    await finding.observe(computer, context());

    const zoom = await finding.zoom(
      computer,
      { frameId: "frame-1", region: { x: 0, y: 0, w: 1, h: 1 } },
      context(),
    );
    expect(zoom).toMatchObject({ width: 1, height: 1, mimeType: "image/png" });

    await expect(
      finding.zoom(computer, { frameId: "frame-0", region: { x: 0, y: 0, w: 1, h: 1 } }, context()),
    ).resolves.toEqual({ unknown: true });
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      perception({}).find(computer, { text: "Save" }, context(controller.signal)),
    ).rejects.toThrow();
  });
});
