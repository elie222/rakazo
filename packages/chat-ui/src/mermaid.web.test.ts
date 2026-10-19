// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mermaid = {
  initialize: vi.fn(),
  parse: vi.fn(async () => true),
  render: vi.fn(async () => ({ svg: "<svg/>" })),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.resetAllMocks();
  mermaid.parse.mockResolvedValue(true);
  mermaid.render.mockResolvedValue({ svg: "<svg/>" });
  vi.doMock("mermaid", () => ({ default: mermaid }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("mermaid");
});

describe("Mermaid render timeout", () => {
  it("times out a hung load and lets the next diagram load and render", async () => {
    const loadGate = Promise.withResolvers<void>();
    const loadStarted = Promise.withResolvers<void>();
    vi.doMock("mermaid", async () => {
      loadStarted.resolve();
      await loadGate.promise;
      return { default: mermaid };
    });
    const { renderMermaidSvg, MERMAID_RENDER_TIMEOUT_MS } = await import("./mermaid.web");
    const stuck = renderMermaidSvg("graph LR; A-->B", "dark");
    await loadStarted.promise;
    await vi.advanceTimersByTimeAsync(MERMAID_RENDER_TIMEOUT_MS);
    await expect(stuck).resolves.toBeNull();
    expect(mermaid.render).not.toHaveBeenCalled();

    loadGate.resolve();
    await expect(renderMermaidSvg("graph LR; B-->C", "dark")).resolves.toBe("<svg/>");
    // The timed-out source is retried too, rather than remembered as invalid.
    await expect(renderMermaidSvg("graph LR; A-->B", "dark")).resolves.toBe("<svg/>");
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });

  it.each(["parse", "render"] as const)(
    "times out a hung %s, advances the queue, and does not cache the timeout",
    async (stage) => {
      mermaid[stage].mockImplementationOnce(() => new Promise<never>(() => {}));
      const { renderMermaidSvg, MERMAID_RENDER_TIMEOUT_MS } = await import("./mermaid.web");
      const stuck = renderMermaidSvg("graph LR; A-->B", "dark");
      const next = renderMermaidSvg("graph LR; B-->C", "dark");
      await vi.advanceTimersByTimeAsync(MERMAID_RENDER_TIMEOUT_MS);
      await expect(stuck).resolves.toBeNull();
      await expect(next).resolves.toBe("<svg/>");
      await expect(renderMermaidSvg("graph LR; A-->B", "dark")).resolves.toBe("<svg/>");
    },
  );
});
