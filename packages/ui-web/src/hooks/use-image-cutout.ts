import { useEffect, useSyncExternalStore } from "react";

const MIN_CLEAR_CORNERS = 2;
const OPAQUE = 255;

const cutoutBySrc = new Map<string, boolean>();
const pendingReads = new Set<string>();
const listeners = new Set<() => void>();

/**
 * Whether a picture is a cutout with its own outline rather than a full frame.
 * False until read, so a photo never flashes without its frame.
 */
export function useImageCutout(src: string | undefined): boolean {
  useEffect(() => {
    // Color and shape avatars have no picture to check
    if (!src) return;

    readCutout(src);
  }, [src]);

  return useSyncExternalStore(
    subscribe,
    () => isKnownCutout(src),
    () => false,
  );
}

/**
 * True when at least two corners are fully see-through.
 */
export function hasCutoutCorners(cornerAlphas: readonly number[]): boolean {
  return cornerAlphas.filter((alpha) => alpha === 0).length >= MIN_CLEAR_CORNERS;
}

/**
 * Returns the cached cutout state for a picture, or false while unknown.
 */
function isKnownCutout(src: string | undefined): boolean {
  // Color and shape avatars have no picture, so they keep the default
  if (!src) return false;

  return cutoutBySrc.get(src) ?? false;
}

/**
 * Subscribes an avatar to cutout updates so useSyncExternalStore re-renders when a read finishes.
 */
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);

  return () => {
    listeners.delete(onChange);
  };
}

/**
 * Reads whether the picture is a cutout and re-renders avatars when finished.
 * Avatars with the same picture share one read.
 */
function readCutout(src: string) {
  // Already cached, or another avatar is reading it
  if (cutoutBySrc.has(src) || pendingReads.has(src)) return;

  pendingReads.add(src);
  void readCornerAlphas(src).then((alphas) => {
    cutoutBySrc.set(src, alphas ? hasCutoutCorners(alphas) : false);
    pendingReads.delete(src);

    for (const notify of listeners) {
      notify();
    }
  });
}

/**
 * Reads transparency of the four corner pixels.
 * Resolves with null if the picture cannot be read, keeping the frame.
 */
function readCornerAlphas(src: string): Promise<number[] | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const { naturalWidth: width, naturalHeight: height } = image;

      // An SVG without explicit dimensions has no pixels to read
      if (!width || !height) {
        resolve(null);
        return;
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");

      // The browser can refuse a 2D canvas (jsdom, low memory); the frame stays
      if (!context) {
        resolve(null);
        return;
      }

      const corners = [
        [0, 0],
        [width - 1, 0],
        [0, height - 1],
        [width - 1, height - 1],
      ] as const;

      try {
        context.drawImage(image, 0, 0);
        resolve(corners.map(([x, y]) => context.getImageData(x, y, 1, 1).data[3] ?? OPAQUE));
      } catch {
        // A picture from another site without CORS taints the canvas, so its pixels cannot be read
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
}
