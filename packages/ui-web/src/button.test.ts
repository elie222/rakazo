import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button.js";

describe("buttonVariants token mapping", () => {
  it("uses elevated/scroll tokens for default and pill chrome", () => {
    const defaultClass = buttonVariants({ variant: "default" });
    const pillClass = buttonVariants({ variant: "pill" });
    expect(defaultClass).toContain("bg-[var(--rk-elevated)]");
    expect(defaultClass).toContain("text-[var(--rk-ink)]");
    expect(defaultClass).toContain("hover:bg-[var(--rk-scroll)]");
    expect(pillClass).toContain("bg-[var(--rk-elevated)]");
    expect(pillClass).toContain("text-[var(--rk-ink)]");
    expect(pillClass).toContain("hover:bg-[var(--rk-scroll)]");
  });

  it("uses cream-ink for cream button text instead of hairline", () => {
    const creamClass = buttonVariants({ variant: "cream" });
    expect(creamClass).toContain("bg-[var(--rk-cream)]");
    expect(creamClass).toContain("text-[var(--rk-cream-ink)]");
    expect(creamClass).not.toContain("--rk-hairline");
  });
});
