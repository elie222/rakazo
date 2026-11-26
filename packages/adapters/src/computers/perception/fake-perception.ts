import { createHash } from "node:crypto";
import type {
  AdapterContext,
  ComputerElement,
  ComputerFindRequest,
  ComputerFindResult,
  ComputerObservation,
  ComputerRect,
  ComputerRef,
  ComputerSettleRequest,
  ComputerSettleResult,
  ComputerWindow,
  ComputerZoomRequest,
} from "@rakazo/adapter-kit";
import type { ComputerCapabilities } from "@rakazo/contracts";
import type { ComputerPerception, ComputerPerceptionUnknown } from "./perception.js";

const EMPTY_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

const DEFAULT_CAPABILITIES: ComputerCapabilities = {
  version: 1,
  search: "service_path",
  programs: {
    git: "available",
    node: "available",
    python3: "available",
  },
  display: { width: 1280, height: 800, scale: 1 },
  perception: {
    atspi: true,
    cdp: true,
    hitTest: true,
    settle: true,
    zoom: true,
  },
  stream: { protocol: "vnc", quality: false },
  recording: false,
  desktopApps: false,
};

export interface FakePerceptionOptions {
  width?: number;
  height?: number;
  scale?: number;
  /** Top-most first: hitTest returns the first element whose bbox contains the point. */
  elements?: readonly ComputerElement[];
  windows?: readonly ComputerWindow[];
  focused?: ComputerElement | null;
  settle?: ComputerSettleResult;
  /** Every lookup answers unknown, as a timed-out helper would. */
  unknown?: boolean;
  /** The next find reports more matches than its limit. */
  truncated?: boolean;
  capabilities?: Partial<ComputerCapabilities>;
  now?: () => number;
}

/**
 * Deterministic perception for tests. It never starts a process and never reads the screen; every
 * answer comes from the elements and windows the test supplied.
 */
export class FakePerception implements ComputerPerception {
  private readonly width: number;
  private readonly height: number;
  private readonly scale: number;
  private readonly elements: readonly ComputerElement[];
  private readonly windows: readonly ComputerWindow[];
  private readonly focusedElement: ComputerElement | null;
  private readonly settleResult: ComputerSettleResult | undefined;
  private readonly unknown: boolean;
  private readonly truncated: boolean;
  private readonly capabilityOverrides: Partial<ComputerCapabilities>;
  private readonly now: () => number;
  private frame = 0;
  private currentFrameId: string | undefined;

  constructor(options: FakePerceptionOptions = {}) {
    this.width = positive(options.width ?? DEFAULT_CAPABILITIES.display.width, "width");
    this.height = positive(options.height ?? DEFAULT_CAPABILITIES.display.height, "height");
    this.scale = positive(options.scale ?? DEFAULT_CAPABILITIES.display.scale, "scale");
    this.elements = [...(options.elements ?? [])];
    this.windows = [...(options.windows ?? [])];
    this.focusedElement = options.focused ?? null;
    this.settleResult = options.settle;
    this.unknown = options.unknown ?? false;
    this.truncated = options.truncated ?? false;
    this.capabilityOverrides = options.capabilities ?? {};
    this.now = options.now ?? Date.now;
  }

  async observe(_computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    context.signal.throwIfAborted();
    const frameId = this.nextFrame("observe");
    this.currentFrameId = frameId;
    return {
      frameId,
      capturedAt: this.capturedAt(),
      mimeType: "image/png",
      image: EMPTY_PNG,
      width: this.width,
      height: this.height,
      pointer: { x: 0, y: 0 },
      windows: this.windows.map(cloneWindow),
    };
  }

  async find(
    _computer: ComputerRef,
    request: ComputerFindRequest,
    context: AdapterContext,
  ): Promise<ComputerFindResult> {
    context.signal.throwIfAborted();
    if (this.unknown) return { elements: [], truncated: false, unknown: true };
    const limit = clampLimit(request.limit);
    const wanted = (request.text ?? "").toLowerCase();
    const role = request.role?.toLowerCase();
    const app = request.app?.toLowerCase();
    const window = request.window?.toLowerCase();
    const matches = this.elements
      .map((element) => ({ element, rank: rank(element.name ?? "", wanted) }))
      .filter(
        ({ element, rank }) =>
          rank !== undefined && (!role || element.role?.toLowerCase().includes(role)),
      )
      .filter(({ element }) => !app || element.app?.toLowerCase() === app)
      .filter(({ element }) => !window || element.window?.toLowerCase() === window)
      .filter(({ element }) => !request.page || element.source === "cdp")
      .sort((left, right) => (left.rank ?? 0) - (right.rank ?? 0))
      .map(({ element }) => cloneElement(element));
    return {
      elements: matches.slice(0, limit),
      truncated: this.truncated || matches.length > limit,
    };
  }

  async hitTest(
    _computer: ComputerRef,
    point: { x: number; y: number },
    context: AdapterContext,
  ): Promise<ComputerElement | null | ComputerPerceptionUnknown> {
    context.signal.throwIfAborted();
    if (this.unknown) return { unknown: true };
    const element = this.elements.find(
      (candidate) => candidate.bbox !== undefined && contains(candidate.bbox, point),
    );
    return element ? { ...cloneElement(element), point: { ...point } } : null;
  }

  async focused(
    _computer: ComputerRef,
    context: AdapterContext,
  ): Promise<ComputerElement | null | ComputerPerceptionUnknown> {
    context.signal.throwIfAborted();
    if (this.unknown) return { unknown: true };
    return this.focusedElement ? cloneElement(this.focusedElement) : null;
  }

  async settle(
    _computer: ComputerRef,
    _request: ComputerSettleRequest,
    context: AdapterContext,
  ): Promise<ComputerSettleResult> {
    context.signal.throwIfAborted();
    const result = this.settleResult ?? {
      changed: [],
      lastChangeMono: null,
      quiet: true,
      noVisibleChange: true,
    };
    return { ...result, changed: result.changed.map((rect) => ({ ...rect })) };
  }

  async zoom(
    _computer: ComputerRef,
    request: ComputerZoomRequest,
    context: AdapterContext,
  ): Promise<ComputerObservation | ComputerPerceptionUnknown> {
    context.signal.throwIfAborted();
    if (this.unknown || request.frameId !== this.currentFrameId) return { unknown: true };
    const region = clampRegion(request.region, this.width, this.height);
    const frameId = this.nextFrame(
      `zoom:${request.frameId}:${region.x}:${region.y}:${region.w}:${region.h}`,
    );
    return {
      frameId,
      capturedAt: this.capturedAt(),
      mimeType: "image/png",
      image: EMPTY_PNG,
      width: region.w,
      height: region.h,
      pointer: { x: 0, y: 0 },
    };
  }

  async capabilities(
    _computer: ComputerRef,
    context: AdapterContext,
  ): Promise<ComputerCapabilities> {
    context.signal.throwIfAborted();
    return {
      ...DEFAULT_CAPABILITIES,
      ...this.capabilityOverrides,
      ...(this.capabilityOverrides.memory
        ? { memory: structuredClone(this.capabilityOverrides.memory) }
        : {}),
      programs: {
        ...DEFAULT_CAPABILITIES.programs,
        ...this.capabilityOverrides.programs,
      },
      display: {
        width: this.capabilityOverrides.display?.width ?? this.width,
        height: this.capabilityOverrides.display?.height ?? this.height,
        scale: this.capabilityOverrides.display?.scale ?? this.scale,
      },
      perception: {
        ...DEFAULT_CAPABILITIES.perception,
        ...this.capabilityOverrides.perception,
      },
      stream: {
        ...DEFAULT_CAPABILITIES.stream,
        ...this.capabilityOverrides.stream,
      },
    };
  }

  private capturedAt(): string {
    return new Date(this.now()).toISOString();
  }

  private nextFrame(signature: string): string {
    this.frame += 1;
    return createHash("sha256").update(`${this.frame}:${signature}`).digest("hex");
  }
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`fake perception ${name} must be a positive number`);
  }
  return value;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 30;
  return Math.max(1, Math.min(300, Math.round(limit)));
}

function contains(rect: ComputerRect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.w && point.y < rect.y + rect.h
  );
}

function clampRegion(region: ComputerRect, width: number, height: number): ComputerRect {
  const x = Math.max(0, Math.min(width - 1, Math.round(region.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(region.y)));
  return {
    x,
    y,
    w: Math.max(1, Math.min(width - x, Math.round(region.w))),
    h: Math.max(1, Math.min(height - y, Math.round(region.h))),
  };
}

/**
 * How well a name answers a search: whole, from its start, from a word's start, or inside it. An
 * empty query ranks every element equally, which keeps the supplied order.
 */
function rank(name: string, wanted: string): number | undefined {
  if (!wanted) return 0;
  const lower = name.toLowerCase();
  if (lower === wanted) return 0;
  if (lower.startsWith(wanted)) return 1;
  const at = lower.indexOf(wanted);
  if (at < 0) return undefined;
  return /[\p{L}\p{N}]/u.test(lower[at - 1] ?? "") ? 3 : 2;
}

function cloneWindow(window: ComputerWindow): ComputerWindow {
  return { ...window, frame: { ...window.frame } };
}

function cloneElement(element: ComputerElement): ComputerElement {
  return {
    ...element,
    point: { ...element.point },
    ...(element.bbox ? { bbox: { ...element.bbox } } : {}),
    ...(element.windowFrame ? { windowFrame: { ...element.windowFrame } } : {}),
    ...(element.state ? { state: { ...element.state } } : {}),
  };
}
