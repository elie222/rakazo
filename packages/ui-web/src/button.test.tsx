// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Button, buttonVariants } from "./components/ui/button.js";
import { cn } from "./lib/utils.js";

describe("buttonVariants", () => {
  it.each(["default", "sm", "xs", "icon-sm", "icon-lg"] as const)(
    "keeps floating buttons a pill at size %s",
    (size) => {
      // Button merges its classes with cn, so later radius classes win.
      const classes = cn(buttonVariants({ variant: "floating", size })).split(" ");
      expect(classes).toContain("rounded-full");
      expect(classes.filter((name) => /^rounded-(?!full$)/.test(name))).toEqual([]);
    },
  );
});

describe("Button", () => {
  it("announces its loading state through the spinner's live status", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<Button loading>Send</Button>));
    expect(host.querySelector("button")?.getAttribute("aria-busy")).toBe("true");
    expect(host.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Loading");
    act(() => root.unmount());
  });
});
