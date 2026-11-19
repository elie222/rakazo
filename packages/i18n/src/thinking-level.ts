import { i18n } from "@lingui/core";
import type { ThinkingLevel } from "@rakazo/contracts";

/** A thinking level as both apps name it, kept here so the copy can't drift between them. */
export function thinkingLevelLabel(level: ThinkingLevel): string {
  if (level === "off") return i18n._({ id: "Off", message: "Off" });
  if (level === "xhigh") return i18n._({ id: "Extra high", message: "Extra high" });
  if (level === "low") return i18n._({ id: "Low", message: "Low" });
  if (level === "medium") return i18n._({ id: "Medium", message: "Medium" });
  if (level === "high") return i18n._({ id: "High", message: "High" });
  if (level === "minimal") return i18n._({ id: "Minimal", message: "Minimal" });
  return i18n._({ id: "Max", message: "Max" });
}
