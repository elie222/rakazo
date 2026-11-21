import { useLingui } from "@lingui/react/macro";
import type { LabFeature } from "@rakazo/contracts";
import { withLab } from "@rakazo/contracts";
import { Switch } from "@rakazo/ui-web";
import { useId } from "react";
import { SettingsGroup, SettingsRow } from "../../components/settings/SettingsRows";
import { useSave } from "../../lib/query/query";
import type { RpcClient } from "../../lib/query/rpc";

export function LabsSettingsPanel({
  labs,
  available,
  onLabsChange,
}: {
  labs: readonly LabFeature[];
  available: readonly LabFeature[];
  /** Saves the whole list; rejects after rolling back. */
  onLabsChange: (labs: LabFeature[], client: RpcClient) => Promise<void>;
}) {
  const { t } = useLingui();
  const id = useId();
  const save = useSave({ save: (next: LabFeature[], client) => onLabsChange(next, client) });
  const copy: Record<LabFeature, { title: string; description: string }> = {
    board: { title: t`Board`, description: t`A kanban board of tickets your bots can work on` },
  };

  return (
    <div className="space-y-2">
      <SettingsGroup data-testid="settings-labs">
        {available.map((feature) => (
          <SettingsRow
            key={feature}
            htmlFor={`${id}-${feature}`}
            label={copy[feature].title}
            description={copy[feature].description}
            descriptionId={`${id}-${feature}-description`}
            control={
              <Switch
                id={`${id}-${feature}`}
                aria-describedby={`${id}-${feature}-description`}
                data-testid={`lab-${feature}-toggle`}
                checked={labs.includes(feature)}
                disabled={save.pending}
                onCheckedChange={(checked) => save.run(withLab(labs, feature, checked))}
              />
            }
          />
        ))}
      </SettingsGroup>
      {save.error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {t`Couldn't update Labs`}
        </p>
      ) : null}
    </div>
  );
}
