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

/**
 * A lookup that did not finish in time. Nothing is known below the window, so a caller must not
 * read this as "no element".
 */
export interface ComputerPerceptionUnknown {
  unknown: true;
}

/**
 * Read-only perception of one computer. Implementations compose the toolkit's accessibility tree,
 * the browser's DevTools protocol and raw screen coordinates; a surface that cannot be read
 * answers `unknown` rather than inventing an element.
 */
export interface ComputerPerception {
  observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation>;
  find(
    computer: ComputerRef,
    request: ComputerFindRequest,
    context: AdapterContext,
  ): Promise<ComputerFindResult>;
  /** The top-most control at a point, or null when the point is on a window's own surface. */
  hitTest(
    computer: ComputerRef,
    point: { x: number; y: number },
    context: AdapterContext,
  ): Promise<ComputerElement | null | ComputerPerceptionUnknown>;
  /** The control with keyboard focus, which is what typing reaches. */
  focused(
    computer: ComputerRef,
    context: AdapterContext,
  ): Promise<ComputerElement | null | ComputerPerceptionUnknown>;
  /** Wait until the application that took the input has handled it. */
  settle(
    computer: ComputerRef,
    request: ComputerSettleRequest,
    context: AdapterContext,
  ): Promise<ComputerSettleResult>;
  /** Read one region of the last observed frame at the screen's device resolution. */
  zoom(
    computer: ComputerRef,
    request: ComputerZoomRequest,
    context: AdapterContext,
  ): Promise<ComputerObservation | ComputerPerceptionUnknown>;
  capabilities(computer: ComputerRef, context: AdapterContext): Promise<ComputerCapabilities>;
}
