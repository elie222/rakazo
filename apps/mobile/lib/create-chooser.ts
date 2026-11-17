import type { MenuAction } from "@expo/ui/community/menu";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { materialIcons } from "./material-icons";

export type CreateAction = "bot" | "group" | "space";

export const createMenuItems = [
  {
    id: "bot",
    label: msg`New bot`,
    sfSymbol: "person.crop.circle.badge.plus",
    materialIcon: "person_add",
  },
  { id: "group", label: msg`New group chat`, sfSymbol: "person.2", materialIcon: "group" },
  {
    id: "space",
    label: msg`New private space`,
    sfSymbol: "square.grid.2x2",
    materialIcon: "grid_view",
  },
] as const;

export function createMenuActions(platform: string): MenuAction[] {
  return createMenuItems.map(({ id, label, sfSymbol, materialIcon }) => ({
    id,
    title: i18n._(label),
    image: platform === "ios" ? sfSymbol : materialIcons[materialIcon],
  }));
}

export function isCreateAction(id: string): id is CreateAction {
  return createMenuItems.some((item) => item.id === id);
}
