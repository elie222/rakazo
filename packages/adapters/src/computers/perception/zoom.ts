import { createHash } from "node:crypto";
import type { ComputerObservation, ComputerRect, ComputerZoomRequest } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";

/** A frame that is no longer the last observation cannot be cropped safely. */
export class ComputerStaleFrameError extends ClientError {
  constructor() {
    super("CONFLICT", "The screen changed since that frame; observe again before zooming.");
    this.name = "ComputerStaleFrameError";
  }
}

export async function zoomObservation(
  observation: ComputerObservation,
  request: ComputerZoomRequest,
): Promise<ComputerObservation> {
  if (request.frameId !== observation.frameId) throw new ComputerStaleFrameError();
  const region = clampRegion(request.region, observation.width, observation.height);
  const { default: sharp } = await import("sharp");
  const image = await sharp(Buffer.from(observation.image))
    .extract({ left: region.x, top: region.y, width: region.w, height: region.h })
    .png()
    .toBuffer();
  return {
    frameId: createHash("sha256").update(image).digest("hex"),
    capturedAt: new Date().toISOString(),
    mimeType: "image/png",
    image: Uint8Array.from(image),
    width: region.w,
    height: region.h,
  };
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
