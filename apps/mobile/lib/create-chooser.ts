import type { MenuAction } from "@expo/ui/community/menu";
import { materialIcons } from "./material-icons";

export type CreateAction = "bot" | "group" | "space";
/** A space the Create menu can make a chat in, named and ordered as its inbox heading. */
export type CreateSpace = { id: string; name: string };

export const createMenuItems = [
  {
    id: "bot",
    label: "New bot",
    sfSymbol: "person.crop.circle.badge.plus",
    materialIcon: "person_add",
  },
  { id: "group", label: "New group chat", sfSymbol: "person.2", materialIcon: "group" },
  {
    id: "space",
    label: "New private space",
    sfSymbol: "square.grid.2x2",
    materialIcon: "grid_view",
  },
] as const;

/** With two or more spaces, a new bot or group chat asks which one it goes in. */
export function createMenuSpaces(id: CreateAction, spaces: readonly CreateSpace[]) {
  return id !== "space" && spaces.length > 1 ? spaces : undefined;
}

export function createMenuActions(
  t: (text: string) => string,
  platform: string,
  spaces: readonly CreateSpace[] = [],
): MenuAction[] {
  return createMenuItems.map(({ id, label, sfSymbol, materialIcon }) => {
    const choices = createMenuSpaces(id, spaces);
    return {
      id,
      title: t(label),
      image: platform === "ios" ? sfSymbol : materialIcons[materialIcon],
      ...(choices
        ? { subactions: choices.map((space) => ({ id: `${id}:${space.id}`, title: space.name })) }
        : {}),
    };
  });
}

export function isCreateAction(id: string): id is CreateAction {
  return createMenuItems.some((item) => item.id === id);
}

/** Reads a picked menu id: an item, or "bot:<spaceId>" or "group:<spaceId>" from a space submenu. */
export function createMenuChoice(id: string): [action: CreateAction, spaceId?: string] | null {
  const split = id.indexOf(":");
  if (split < 0) return isCreateAction(id) ? [id] : null;
  const action = id.slice(0, split);
  const spaceId = id.slice(split + 1);
  return isCreateAction(action) && action !== "space" && spaceId ? [action, spaceId] : null;
}
