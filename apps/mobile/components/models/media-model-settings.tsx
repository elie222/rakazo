import { useLingui } from "@lingui/react/macro";
import type {
  MediaModelChoice,
  MediaModelRole,
  MediaModelsView,
  SettingsScope,
} from "@rakazo/contracts";
import { withConnectionName } from "@rakazo/contracts";
import type { DataTag, QueryKey } from "@tanstack/react-query";
import { errorText } from "../../lib/api/user-error";
import type { ModelPickerRequest } from "../../lib/models/model-picker-selection";
import { queryClient, useSave } from "../../lib/query/query";
import type { SettingsTarget } from "../../lib/query/settings-target";
import { SettingsGroup, SettingsRow } from "../settings/settings-group";

const choiceKey = (choice: MediaModelChoice) =>
  JSON.stringify([choice.credentialId, choice.modelId]);

/** The image and video models bots use, shown only for media the member's own keys can make. */
export function MediaModelSettings({
  view,
  target,
  scope,
  readKey,
  openPicker,
}: {
  view: MediaModelsView;
  target: SettingsTarget;
  scope: SettingsScope;
  /** The screen's read of `view`, which a save answers with the new one. */
  readKey: DataTag<QueryKey, MediaModelsView, Error>;
  openPicker: (request: ModelPickerRequest) => void;
}) {
  const { t } = useLingui();
  const saving = useSave({
    target,
    save: (input: { role: MediaModelRole; choice: MediaModelChoice }, send) =>
      send("models/setMedia", { role: input.role, ...input.choice, scope }),
    onSaved: (next) => queryClient.setQueryData(readKey, next),
  });
  const roles = (
    [
      ["image", t`Image model`],
      ["video", t`Video model`],
    ] as const
  ).filter(([role]) => view[role].options.length > 0);
  if (roles.length === 0) return null;
  return roles.map(([role, title]) => {
    const { options, selected } = view[role];
    const pending = saving.pending && saving.input?.role === role ? saving.input.choice : null;
    const shownKey = choiceKey(pending ?? selected ?? { credentialId: "", modelId: "" });
    const shown = options.find((option) => choiceKey(option) === shownKey);
    return (
      <SettingsGroup
        key={role}
        accessibilityLabel={title}
        label={title}
        footer={
          saving.error && saving.input?.role === role
            ? errorText(saving.error, t`Could not save model`)
            : undefined
        }
      >
        <SettingsRow
          accessibilityRole="button"
          title={shown?.label ?? t`Choose a model`}
          detail={shown?.connectionLabel}
          disabled={saving.pending}
          onPress={() =>
            openPicker({
              title,
              selectedKey: shownKey,
              choices: options.map((option) => ({
                key: choiceKey(option),
                label: withConnectionName(option.label, option.connectionLabel),
                modelLabel: option.label,
                providerLabel: option.connectionLabel,
                provider: option.provider,
                modelId: option.modelId,
              })),
              onSelect: (choice) => {
                const option = options.find((entry) => choiceKey(entry) === choice.key);
                if (option && choice.key !== shownKey)
                  saving.run({
                    role,
                    choice: { credentialId: option.credentialId, modelId: option.modelId },
                  });
              },
            })
          }
        />
      </SettingsGroup>
    );
  });
}
