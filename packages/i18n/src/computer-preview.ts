import { t } from "@lingui/core/macro";

export function computerPreviewPlaceholder(
  state: string | undefined,
  booting: boolean,
  wakeAction: "open" | "takeControl" = "open",
) {
  if (state === "booting" || booting) return t`Booting live desktop…`;
  if (state === "running") return t`Connecting to the screen…`;
  if (state === "suspended")
    return wakeAction === "takeControl"
      ? t`Computer is asleep. Take control to wake it.`
      : t`Computer is asleep. Open it to wake.`;
  if (state === "error") return t`Computer failed to boot`;
  return t`Computer is stopped`;
}
