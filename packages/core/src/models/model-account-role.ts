import type { ModelRoleChoice, ModelRoleSettings, ThinkingLevel } from "@rakazo/contracts";
import { modelRoleChoiceKey } from "@rakazo/contracts";
import type { ModelRoleTransport } from "./model-role-settings.js";
import { createModelRoleSettings, modelRoleListPatch } from "./model-role-settings.js";

const same = (left: ModelRoleChoice, right: ModelRoleChoice) =>
  modelRoleChoiceKey(left) === modelRoleChoiceKey(right);
const rows = (settings: ModelRoleSettings) =>
  settings.primary ? [settings.primary, ...settings.backups] : settings.backups;

/** Account UI uses the ordinary role lifecycle and saves against the latest confirmed list. */
export function createAccountModelRole(transport: ModelRoleTransport, scopeKey: string) {
  const controller = createModelRoleSettings(transport, scopeKey);
  return {
    ...controller,
    select(slot: ModelRoleChoice | "add" | "primary", choice: ModelRoleChoice | null) {
      return controller.save((current) => {
        if (slot === "primary")
          return current.primary && choice && same(current.primary, choice)
            ? {}
            : {
                primary: choice,
                backups: choice
                  ? current.backups.filter((item) => !same(item, choice))
                  : current.backups,
              };
        if (!choice || rows(current).some((item) => same(item, choice))) return {};
        const list = rows(current);
        const index = slot === "add" ? -1 : list.findIndex((item) => same(item, slot));
        return modelRoleListPatch(
          current,
          index < 0 ? [...list, choice] : list.map((item, at) => (at === index ? choice : item)),
        );
      });
    },
    move(choice: ModelRoleChoice, offset: number) {
      return controller.save((current) => {
        const list = rows(current);
        const index = list.findIndex((item) => same(item, choice));
        const target = index + offset;
        if (index < 0 || target < 0 || target >= list.length) return {};
        list.splice(target, 0, ...list.splice(index, 1));
        return modelRoleListPatch(current, list);
      });
    },
    remove(choice: ModelRoleChoice) {
      return controller.save((current) =>
        modelRoleListPatch(
          current,
          rows(current).filter((item) => !same(item, choice)),
        ),
      );
    },
    thinking(level: ThinkingLevel | null) {
      return controller.save((current) => ({
        primary: current.primary && { ...current.primary, thinkingLevel: level },
      }));
    },
  };
}
