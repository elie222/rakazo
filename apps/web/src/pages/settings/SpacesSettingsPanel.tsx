import { useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { Plus } from "lucide-react";
import { SettingsGroup, SettingsRow } from "../../components/settings/SettingsRows";

/** Every Space this person can open, each by name, even when there is only one. */
export function SpacesSettingsPanel({
  spaces,
  onOpenSpace,
  onNewSpace,
}: {
  spaces: { id: string; name: string }[];
  onOpenSpace: (spaceId: string) => void;
  onNewSpace?: () => void;
}) {
  const { t } = useLingui();
  return (
    <div className="space-y-8" data-testid="settings-spaces">
      <SettingsGroup>
        {spaces.map((option) => (
          <SettingsRow
            key={option.id}
            label={<p className="break-words">{option.name}</p>}
            control={
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full"
                aria-label={t`Manage ${option.name}`}
                onClick={() => onOpenSpace(option.id)}
              >
                {t`Manage`}
              </Button>
            }
          />
        ))}
      </SettingsGroup>
      {onNewSpace ? (
        <Button variant="outline" className="rounded-full" onClick={onNewSpace}>
          <Plus />
          {t`New private space`}
        </Button>
      ) : null}
    </div>
  );
}
