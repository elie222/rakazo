import { useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { Plus } from "lucide-react";
import { SettingsGroup, SettingsRow } from "../../components/settings/SettingsRows";
import { SpaceMembersSettings } from "../../components/spaces/SpaceMembersSettings";
import type { SettingsSpace } from "../shell/create-delete-dialogs";
import { SpaceSettingOverrides } from "./SpaceSettingOverrides";

/**
 * Every Space this person can open. With only one, it is just the app: its members are shown here,
 * and its overrides only when some were customized while there were others.
 */
export function SpacesSettingsPanel({
  space,
  spaces,
  onOpenSpace,
  onNewSpace,
  onLeft,
  onClose,
  onBusyChange,
}: {
  /** The Space the app is showing. */
  space: SettingsSpace | null;
  spaces: { id: string; name: string }[];
  onOpenSpace: (spaceId: string) => void;
  onNewSpace?: () => void;
  onLeft: (spaceId: string, activeSpaceId: string) => void;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const newSpace = onNewSpace ? (
    <Button variant="outline" className="rounded-full" onClick={onNewSpace}>
      <Plus />
      {t`New private space`}
    </Button>
  ) : null;

  if (spaces.length <= 1) {
    return (
      <div className="space-y-8" data-testid="settings-spaces">
        {space ? (
          <SpaceMembersSettings
            space={space}
            onLeft={(activeSpaceId) => onLeft(space.id, activeSpaceId)}
          />
        ) : null}
        <SpaceSettingOverrides hideUntilCustomized onClose={onClose} onBusyChange={onBusyChange} />
        {newSpace}
      </div>
    );
  }

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
      {newSpace}
    </div>
  );
}
