export type AskAction = { id: string; label: string; outcome?: "created" | "cancelled" };

/**
 * The server's labels on the user's-computer approval, whose "allow" covers the whole space. Cards
 * from before it covered the space carry the older label.
 */
const ALLOW_IN_SPACE = new Set(["Allow in this space", "Allow for this chat"]);

export function allowsSpace(actions: AskAction[] | undefined): boolean {
  return actions?.some((action) => ALLOW_IN_SPACE.has(action.label)) ?? false;
}

export function askActionLabel(
  action: AskAction,
  { approval, site }: { approval: boolean; site?: string },
  t: (message: string, values?: Record<string, string | number>) => string,
): string {
  if (!approval) return action.label;
  if (action.outcome === "created") return t("Create space");
  if (action.outcome === "cancelled") return t("Cancel");
  if (action.id === "allow")
    return ALLOW_IN_SPACE.has(action.label) ? t("Allow in this space") : t("Allow once");
  if (action.id === "always")
    return site ? t("Always allow {site}", { site }) : t("Always allow this tool");
  if (action.id === "deny") return t("Deny");
  return action.label;
}
