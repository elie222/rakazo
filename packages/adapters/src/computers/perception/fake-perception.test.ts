import type {
  AdapterContext,
  ComputerElement,
  ComputerRef,
  ComputerWindow,
} from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { FakePerception } from "./fake-perception.js";

const computer: ComputerRef = {
  id: "computer",
  botId: "bot",
  kind: "fake",
  providerRef: "provider",
};

const window: ComputerWindow = {
  id: 7,
  pid: 100,
  cls: "Thunar",
  title: "Files",
  frame: { x: 0, y: 0, w: 800, h: 600 },
  active: true,
};

const save: ComputerElement = {
  point: { x: 700, y: 580 },
  bbox: { x: 680, y: 570, w: 80, h: 20 },
  windowFrame: window.frame,
  source: "ax",
  app: "Thunar",
  window: "Files",
  role: "button",
  name: "Save",
  ref: "e1",
};

const home: ComputerElement = {
  ...save,
  point: { x: 20, y: 20 },
  bbox: { x: 0, y: 0, w: 100, h: 40 },
  role: "link",
  name: "Home",
  ref: "e2",
};

const pageButton: ComputerElement = {
  ...save,
  point: { x: 300, y: 300 },
  bbox: { x: 280, y: 290, w: 40, h: 20 },
  source: "cdp",
  app: "Chromium",
  window: "Example",
  role: "button",
  name: "Submit",
  ref: "e3",
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

function perception(options: ConstructorParameters<typeof FakePerception>[0] = {}) {
  return new FakePerception({
    windows: [window],
    elements: [save, home, pageButton],
    focused: save,
    ...options,
  });
}

describe("FakePerception", () => {
  it("returns the configured screen, pointer and a copy of the windows", async () => {
    const observed = await perception({ width: 1920, height: 1080 }).observe(computer, context());

    expect(observed.width).toBe(1920);
    expect(observed.height).toBe(1080);
    expect(observed.pointer).toEqual({ x: 0, y: 0 });
    expect(observed.windows).toEqual([window]);
    expect(observed.windows?.[0]).not.toBe(window);
    expect(observed.windows?.[0]?.frame).not.toBe(window.frame);
    expect([...observed.image.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("finds by exact name, prefix and role, and keeps the input order", async () => {
    const finding = perception();

    expect((await finding.find(computer, { text: "Save" }, context())).elements).toEqual([save]);
    expect((await finding.find(computer, { text: "Hom" }, context())).elements).toEqual([home]);
    expect(
      (await finding.find(computer, { role: "button" }, context())).elements.map(
        (element) => element.name,
      ),
    ).toEqual(["Save", "Submit"]);
  });

  it("filters by app, window and page", async () => {
    const finding = perception();

    expect(
      (await finding.find(computer, { app: "Thunar" }, context())).elements.map(
        (element) => element.name,
      ),
    ).toEqual(["Save", "Home"]);
    expect(
      (await finding.find(computer, { window: "Files" }, context())).elements.map(
        (element) => element.name,
      ),
    ).toEqual(["Save", "Home"]);
    expect((await finding.find(computer, { page: true }, context())).elements).toEqual([
      pageButton,
    ]);
  });

  it("honors the limit and reports truncation", async () => {
    const result = await perception().find(computer, { text: "S", limit: 1 }, context());

    expect(result.elements).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("returns unknown instead of an empty result when the lookup timed out", async () => {
    const result = await perception({ unknown: true }).find(computer, { text: "Save" }, context());

    expect(result).toEqual({ elements: [], truncated: false, unknown: true });
  });

  it("hits the top-most element at a point and returns null on the window surface", async () => {
    const finding = perception();

    expect(await finding.hitTest(computer, { x: 700, y: 580 }, context())).toMatchObject({
      name: "Save",
      point: { x: 700, y: 580 },
    });
    expect(await finding.hitTest(computer, { x: 0, y: 0 }, context())).toMatchObject({
      name: "Home",
    });
    expect(await finding.hitTest(computer, { x: 500, y: 500 }, context())).toBeNull();
  });

  it("returns unknown from a hit test that did not finish", async () => {
    expect(
      await perception({ unknown: true }).hitTest(computer, { x: 700, y: 580 }, context()),
    ).toEqual({ unknown: true });
  });

  it("returns the configured focused control", async () => {
    expect(await perception().focused(computer, context())).toEqual(save);
    expect(await perception({ focused: null }).focused(computer, context())).toBeNull();
    expect(await perception({ unknown: true }).focused(computer, context())).toEqual({
      unknown: true,
    });
  });

  it("returns the configured settle result, and a quiet screen by default", async () => {
    const changed = { x: 10, y: 20, w: 30, h: 40 };
    expect(
      await perception({
        settle: { changed: [changed], lastChangeMono: 12, quiet: true, noVisibleChange: false },
      }).settle(computer, { verb: "click" }, context()),
    ).toEqual({ changed: [changed], lastChangeMono: 12, quiet: true, noVisibleChange: false });
    expect(await perception().settle(computer, {}, context())).toEqual({
      changed: [],
      lastChangeMono: null,
      quiet: true,
      noVisibleChange: true,
    });
  });

  it("zooms the current frame and refuses a stale or unknown frame", async () => {
    const finding = perception();
    const observed = await finding.observe(computer, context());

    const zoom = await finding.zoom(
      computer,
      { frameId: observed.frameId, region: { x: 10, y: 20, w: 640, h: 400 } },
      context(),
    );
    expect(zoom).toMatchObject({ width: 640, height: 400 });

    expect(
      await finding.zoom(
        computer,
        { frameId: "stale", region: { x: 10, y: 20, w: 640, h: 400 } },
        context(),
      ),
    ).toEqual({ unknown: true });
    expect(
      await perception({ unknown: true }).zoom(
        computer,
        { frameId: observed.frameId, region: { x: 10, y: 20, w: 640, h: 400 } },
        context(),
      ),
    ).toEqual({ unknown: true });
  });

  it("merges capability overrides without losing the defaults", async () => {
    const capabilities = await perception({
      width: 1920,
      height: 1080,
      scale: 2,
      capabilities: {
        recording: true,
        programs: { libreoffice: "available" },
        display: { width: 2560, height: 1600, scale: 2 },
      },
    }).capabilities(computer, context());

    expect(capabilities.recording).toBe(true);
    expect(capabilities.programs).toEqual({
      git: "available",
      node: "available",
      python3: "available",
      libreoffice: "available",
    });
    expect(capabilities.display).toEqual({ width: 2560, height: 1600, scale: 2 });
  });

  it("stops every lookup when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const finding = perception();

    await expect(finding.observe(computer, context(controller.signal))).rejects.toThrow();
    await expect(finding.find(computer, {}, context(controller.signal))).rejects.toThrow();
    await expect(
      finding.hitTest(computer, { x: 1, y: 1 }, context(controller.signal)),
    ).rejects.toThrow();
    await expect(finding.focused(computer, context(controller.signal))).rejects.toThrow();
    await expect(
      finding.zoom(
        computer,
        { frameId: "frame", region: { x: 0, y: 0, w: 1, h: 1 } },
        context(controller.signal),
      ),
    ).rejects.toThrow();
    await expect(finding.settle(computer, {}, context(controller.signal))).rejects.toThrow();
    await expect(finding.capabilities(computer, context(controller.signal))).rejects.toThrow();
  });

  it("rejects a non-positive screen", () => {
    expect(() => new FakePerception({ width: 0 })).toThrow(RangeError);
    expect(() => new FakePerception({ height: -1 })).toThrow(RangeError);
    expect(() => new FakePerception({ scale: 0 })).toThrow(RangeError);
  });
});
