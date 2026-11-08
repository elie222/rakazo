import type { MenuAction } from "@expo/ui/community/menu";
import { materialIcons } from "./material-icons";

export type CreateAction = "bot" | "import-bot" | "group" | "space";

type CreateMenuItem = {
  id: CreateAction;
  label: string;
  sfSymbol: string;
  materialIcon?: keyof typeof materialIcons;
};

export const createMenuItems: CreateMenuItem[] = [
  {
    id: "bot",
    label: "New bot",
    sfSymbol: "person.crop.circle.badge.plus",
    materialIcon: "person_add",
  },
  {
    id: "import-bot",
    label: "Import bot",
    sfSymbol: "square.and.arrow.down",
  },
  { id: "group", label: "New group chat", sfSymbol: "person.2", materialIcon: "group" },
  {
    id: "space",
    label: "New private space",
    sfSymbol: "square.grid.2x2",
    materialIcon: "grid_view",
  },
];

export function createMenuActions(t: (text: string) => string, platform: string): MenuAction[] {
  return createMenuItems.map(({ id, label, sfSymbol, materialIcon }) => ({
    id,
    title: t(label),
    image: platform === "ios" ? sfSymbol : materialIcon ? materialIcons[materialIcon] : undefined,
  }));
}

export function isCreateAction(id: string): id is CreateAction {
  return createMenuItems.some((item) => item.id === id);
}
