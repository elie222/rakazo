import type {
  AdapterContext,
  ComputerElement,
  ComputerFindRequest,
  ComputerFindResult,
  ComputerObservation,
  ComputerRef,
  ComputerSettleRequest,
  ComputerSettleResult,
  ComputerZoomRequest,
} from "@rakazo/adapter-kit";
import type { ComputerCapabilities } from "@rakazo/contracts";
import { shellQuote } from "../screens/computer-support.js";
import { unavailableCapabilities } from "./capabilities.js";
import type { ComputerPerception, ComputerPerceptionUnknown } from "./perception.js";
import { settleScreen } from "./settle.js";
import { zoomObservation } from "./zoom.js";

export interface AtspiPerceptionHost {
  /**
   * Run a command with `input` on its stdin. Docker, E2B, Daytona and Boat implement it for the
   * page browser; a provider without it has no semantic perception.
   */
  runWithInput?(
    computer: ComputerRef,
    command: string,
    input: string,
    timeoutMs: number,
    context: AdapterContext,
  ): Promise<{ code: number; stdout: string }>;
}

export interface AtspiPerceptionOptions {
  /** The X display this bot owns, such as `:1`. */
  display(computer: ComputerRef, context: AdapterContext): Promise<string>;
  observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation>;
  /** The screen size, for a conservative capability report when the helper is unavailable. */
  screen?(
    computer: ComputerRef,
    context: AdapterContext,
  ): Promise<{ width: number; height: number; scale: number }>;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const PERCEPTION_TIMEOUT_MS = 5_000;

/**
 * AT-SPI perception over the persistent helper in the computer image. The helper is asked by a
 * short-lived CLI so an application that stops answering cannot hold the adapter's process.
 */
export class AtspiPerception implements ComputerPerception {
  private lastObservation: ComputerObservation | undefined;

  constructor(
    private readonly host: AtspiPerceptionHost,
    private readonly options: AtspiPerceptionOptions,
  ) {}

  /** Keep the last observation for a later zoom, which crops it at device resolution. */
  remember(observation: ComputerObservation): void {
    this.lastObservation = observation;
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const observation = await this.options.observe(computer, context);
    this.lastObservation = observation;
    return observation;
  }

  async find(
    computer: ComputerRef,
    request: ComputerFindRequest,
    context: AdapterContext,
  ): Promise<ComputerFindResult> {
    const response = await this.request<ComputerFindResult>(computer, context, {
      cmd: "find",
      ...request,
    });
    if ("unknown" in response) return { elements: [], truncated: false, unknown: true };
    return response;
  }

  async hitTest(
    computer: ComputerRef,
    point: { x: number; y: number },
    context: AdapterContext,
  ): Promise<ComputerElement | null | ComputerPerceptionUnknown> {
    const response = await this.request<{ element: ComputerElement | null }>(computer, context, {
      cmd: "at",
      point,
    });
    return "unknown" in response ? response : response.element;
  }

  async focused(
    computer: ComputerRef,
    context: AdapterContext,
  ): Promise<ComputerElement | null | ComputerPerceptionUnknown> {
    const response = await this.request<{ element: ComputerElement | null }>(computer, context, {
      cmd: "focused",
    });
    return "unknown" in response ? response : response.element;
  }

  async settle(
    computer: ComputerRef,
    request: ComputerSettleRequest,
    context: AdapterContext,
  ): Promise<ComputerSettleResult> {
    return settleScreen(request, context.signal, {
      observe: () => this.observe(computer, context),
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
    });
  }

  async zoom(
    _computer: ComputerRef,
    request: ComputerZoomRequest,
    context: AdapterContext,
  ): Promise<ComputerObservation | ComputerPerceptionUnknown> {
    context.signal.throwIfAborted();
    if (this.lastObservation?.frameId !== request.frameId) return { unknown: true };
    return zoomObservation(this.lastObservation, request);
  }

  async capabilities(
    computer: ComputerRef,
    context: AdapterContext,
  ): Promise<ComputerCapabilities> {
    const response = await this.request<ComputerCapabilities>(computer, context, {
      cmd: "capabilities",
    });
    if ("unknown" in response) return this.unavailableCapabilities(computer, context);
    return response;
  }

  private async request<T extends object>(
    computer: ComputerRef,
    context: AdapterContext,
    body: Record<string, unknown>,
  ): Promise<T | ComputerPerceptionUnknown> {
    context.signal.throwIfAborted();
    const run = this.host.runWithInput;
    if (!run) return { unknown: true };
    const display = await this.options.display(computer, context);
    const request = `${JSON.stringify({ ...body, display })}\n`;
    try {
      const result = await run.call(
        this.host,
        computer,
        `DISPLAY=${shellQuote(display)} /usr/local/bin/rakazo-perception`,
        request,
        this.options.timeoutMs ?? PERCEPTION_TIMEOUT_MS,
        context,
      );
      if (result.code !== 0) return { unknown: true };
      const parsed = JSON.parse(result.stdout) as { ok?: boolean; unknown?: boolean } & T;
      if (parsed.ok !== true || parsed.unknown === true) return { unknown: true };
      return parsed;
    } catch (error) {
      if (context.signal.aborted) throw error;
      return { unknown: true };
    }
  }

  private async unavailableCapabilities(
    computer: ComputerRef,
    context: AdapterContext,
  ): Promise<ComputerCapabilities> {
    const screen = this.options.screen
      ? await this.options.screen(computer, context)
      : { width: 1280, height: 800, scale: 1 };
    return unavailableCapabilities(screen);
  }
}
