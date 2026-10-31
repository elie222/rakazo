import type { ReactNode } from "react";
import { BrandMark } from "../components/BrandMark";
import { WindowStrip } from "./WindowChrome";

/**
 * The frame of the sign-in and setup pages: the brand mark and title centred on the page, under
 * a strip that carries the desktop window controls and lets the window be dragged.
 */
export function EntryFrame({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    // The desktop app waits for a marked surface before it shows the page.
    <div
      data-rakazo-surface="entry"
      className="flex min-h-full flex-col bg-background text-foreground"
    >
      <WindowStrip />
      <div className="flex flex-1 items-center justify-center px-6 pb-16">
        <div className="flex w-[460px] max-w-full flex-col items-center">
          <BrandMark />
          <h1
            aria-live="polite"
            className="mb-9 mt-7 text-center text-4xl font-medium tracking-tight"
          >
            {title}
          </h1>
          {children}
        </div>
      </div>
    </div>
  );
}
