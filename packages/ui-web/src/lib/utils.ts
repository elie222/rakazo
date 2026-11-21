import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The web type scale in styles.css. Registered as font sizes so `text-heading2 text-foreground`
// keeps both instead of being merged as two text colours.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        "caption",
        "label",
        "body-sm",
        "body",
        "body-lg",
        "heading3",
        "heading2",
        "heading1",
        "display",
      ],
      // The semantic shadows in styles.css. Registered as sizes so a caller's `shadow-none`
      // or `shadow-lg` replaces them instead of stacking a second shadow.
      shadow: ["outline", "control", "popover", "dialog"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * One surface for every menu and popover: the same radius, token shadow and hairline edge,
 * so a dropdown, a context menu and a select read as the same material.
 */
export const floatingSurface =
  "rounded-xl bg-popover text-popover-foreground shadow-popover ring-1 ring-foreground/10";
