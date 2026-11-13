import { useLingui } from "@lingui/react/macro";
import type { LabFeature } from "@rakazo/contracts";
import { LAB_FEATURES, withLab } from "@rakazo/contracts";
import { Label, Switch } from "@rakazo/ui-web";
import { useId, useState } from "react";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";

export function LabsSettingsPanel({
  labs,
  onLabsChange,
}: {
  labs: readonly LabFeature[];
  /** Saves the whole list; rejects after rolling back. */
  onLabsChange: (labs: LabFeature[]) => Promise<void>;
}) {
  const { t } = useLingui();
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labels: Record<LabFeature, string> = { board: t`Board` };

  async function toggle(feature: LabFeature, enabled: boolean) {
    setPending(true);
    setError(null);
    try {
      await onLabsChange(withLab(labs, feature, enabled));
    } catch {
      setError(t`Couldn't update Labs`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <SettingsGroup data-testid="settings-labs">
        {LAB_FEATURES.map((feature) => (
          <SettingsRow
            key={feature}
            label={
              <Label htmlFor={`${id}-${feature}`} className="text-body font-normal text-foreground">
                {labels[feature]}
              </Label>
            }
            control={
              <Switch
                id={`${id}-${feature}`}
                data-testid={`lab-${feature}-toggle`}
                checked={labs.includes(feature)}
                disabled={pending}
                onCheckedChange={(checked) => void toggle(feature, checked)}
              />
            }
          />
        ))}
      </SettingsGroup>
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
