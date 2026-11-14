import { useLingui } from "@lingui/react/macro";
import type { LabFeature } from "@rakazo/contracts";
import { withLab } from "@rakazo/contracts";
import { Label, Switch } from "@rakazo/ui-web";
import { useId, useState } from "react";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";

export function LabsSettingsPanel({
  labs,
  available,
  onLabsChange,
}: {
  labs: readonly LabFeature[];
  available: readonly LabFeature[];
  /** Saves the whole list; rejects after rolling back. */
  onLabsChange: (labs: LabFeature[]) => Promise<void>;
}) {
  const { t } = useLingui();
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy: Record<LabFeature, { title: string; description: string }> = {
    board: { title: t`Board`, description: t`A kanban board of tickets your bots can work on` },
  };

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
        {available.map((feature) => (
          <SettingsRow
            key={feature}
            label={
              <>
                <Label
                  htmlFor={`${id}-${feature}`}
                  className="text-body font-normal text-foreground"
                >
                  {copy[feature].title}
                </Label>
                <p
                  id={`${id}-${feature}-description`}
                  className="mt-0.5 text-body-sm text-muted-foreground"
                >
                  {copy[feature].description}
                </p>
              </>
            }
            control={
              <Switch
                id={`${id}-${feature}`}
                aria-describedby={`${id}-${feature}-description`}
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
