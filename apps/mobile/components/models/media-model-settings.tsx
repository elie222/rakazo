import { useLingui } from "@lingui/react/macro";
import type {
  MediaModelChoice,
  MediaModelRole,
  MediaModelsView,
  SettingsScope,
} from "@rakazo/contracts";
import type { DataTag, QueryKey } from "@tanstack/react-query";
import { errorText } from "../../lib/api/user-error";
import { queryClient, useSave } from "../../lib/query/query";
import type { SettingsTarget } from "../../lib/query/settings-target";
import { SettingsGroup } from "../settings/settings-group";
import { MenuPicker } from "../ui/menu-picker";

const choiceKey = (choice: MediaModelChoice) =>
  JSON.stringify([choice.credentialId, choice.modelId]);

/** The image and video models bots use, shown only for media the member's own keys can make. */
export function MediaModelSettings({
  view,
  target,
  scope,
  readKey,
}: {
  view: MediaModelsView;
  target: SettingsTarget;
  scope: SettingsScope;
  /** The screen's read of `view`, which a save answers with the new one. */
  readKey: DataTag<QueryKey, MediaModelsView, Error>;
}) {
  const { t } = useLingui();
  const saving = useSave({
    target,
    save: (input: { role: MediaModelRole; choice: MediaModelChoice }, send) =>
      send("models/setMedia", { role: input.role, ...input.choice, scope }),
    onSaved: (next) => queryClient.setQueryData(readKey, next),
  });
  const rows = (
    [
      ["image", t`Image model`],
      ["video", t`Video model`],
    ] as const
  ).filter(([role]) => view[role].options.length > 0);
  if (rows.length === 0) return null;
  return (
    <SettingsGroup
      footer={saving.error ? errorText(saving.error, t`Could not save model`) : undefined}
    >
      {rows.map(([role, label]) => {
        const { options, selected } = view[role];
        return (
          <MenuPicker
            key={role}
            label={label}
            disabled={saving.pending}
            choices={options.map((option) => ({ key: choiceKey(option), label: option.label }))}
            value={selected ? choiceKey(selected) : ""}
            onChange={(key) => {
              const choice = options.find((option) => choiceKey(option) === key);
              if (choice)
                saving.run({
                  role,
                  choice: { credentialId: choice.credentialId, modelId: choice.modelId },
                });
            }}
          />
        );
      })}
    </SettingsGroup>
  );
}
