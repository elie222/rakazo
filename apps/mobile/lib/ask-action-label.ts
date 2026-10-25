export type AskAction = { id: string; label: string; outcome?: "created" | "cancelled" };

export function askActionLabel(
  action: AskAction,
  { approval, site }: { approval: boolean; site?: string },
  t: (message: string, values?: Record<string, string | number>) => string,
): string {
  if (!approval) return action.label;
  if (action.outcome === "created") return t("Create space");
  if (action.outcome === "cancelled") return t("Cancel");
  if (action.id === "allow") return t("Allow once");
  if (action.id === "always")
    return site ? t("Always allow {site}", { site }) : t("Always allow this tool");
  if (action.id === "deny") return t("Deny");
  return action.label;
}
