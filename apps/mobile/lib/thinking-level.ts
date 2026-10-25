import type { ThinkingLevel } from "@rakazo/contracts";

export function thinkingLevelLabel(level: ThinkingLevel, t: (message: string) => string): string {
  if (level === "xhigh") return t("Extra high");
  if (level === "low") return t("Low");
  if (level === "medium") return t("Medium");
  if (level === "high") return t("High");
  if (level === "minimal") return t("Minimal");
  if (level === "max") return t("Max");
  return `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;
}
