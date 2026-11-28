import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { SettingsGroup, SettingsRow } from "../../components/settings/SettingsRows";
import { SpaceMembersSettings } from "../../components/spaces/SpaceMembersSettings";
import { useSave } from "../../lib/query/query";
import type { RpcClient } from "../../lib/query/rpc";
import { errorText } from "../../lib/query/user-error";
import type { SettingsSpace } from "../shell/create-delete-dialogs";
import { DeleteSpaceDialog } from "../shell/create-delete-dialogs";
import { SpaceSettingOverrides } from "./SpaceSettingOverrides";

/**
 * One space's page: its name, its members, the account settings it customizes, and deletion for
 * its owner.
 */
export function SpaceSettingsPanel({
  space,
  lone = false,
  onRename,
  onDelete,
  onLeft,
  onClose,
  onBusyChange,
  vaultItem,
}: {
  space: SettingsSpace;
  /** The only Space follows the account, so its overrides show only once one was customized. */
  lone?: boolean;
  onRename: (name: string, client: RpcClient) => Promise<void>;
  onDelete: () => Promise<void>;
  /** After leaving, with the space the server moved this person to. */
  onLeft: (activeSpaceId: string) => void;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
  /** The item the Space's own Vault opens at. */
  vaultItem?: string;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [draft, setDraft] = useState(space.name);
  const rename = useSave({
    save: (name: string, client) => onRename(name, client),
    onSaved: (_, name) => setDraft(name),
  });
  const pending = rename.pending;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [overridesBusy, setOverridesBusy] = useState(false);
  // A rename in flight holds the dialog open, so a failure is shown instead of lost on leaving.
  const busy = pending || overridesBusy;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  function save() {
    const trimmed = draft.trim();
    if (pending) return;
    if (!trimmed || trimmed === space.name) {
      setDraft(space.name);
      rename.reset();
      return;
    }
    rename.run(trimmed);
  }

  return (
    <div className="space-y-8" data-testid="space-settings">
      {space.canRename ? (
        <SettingsGroup>
          <SettingsRow
            label={
              <label htmlFor={nameId}>
                <Trans>Name</Trans>
              </label>
            }
            control={
              <Input
                id={nameId}
                className="w-56"
                maxLength={60}
                value={draft}
                disabled={pending}
                onChange={(event) => {
                  setDraft(event.target.value);
                  rename.reset();
                }}
                onBlur={save}
                onKeyDown={(event) => {
                  if (event.key === "Escape") event.stopPropagation();
                  // Enter or Escape that ends an IME composition is not a commit or cancel.
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    setDraft(space.name);
                    rename.reset();
                  }
                }}
              />
            }
          >
            {rename.error ? (
              <p role="alert" className="pt-2 text-body-sm text-destructive">
                {errorText(rename.error, t`Could not rename space`)}
              </p>
            ) : null}
          </SettingsRow>
        </SettingsGroup>
      ) : null}
      <SpaceMembersSettings space={space} onLeft={onLeft} />
      <SpaceSettingOverrides
        hideUntilCustomized={lone}
        onClose={onClose}
        onBusyChange={setOverridesBusy}
        vaultItem={vaultItem}
      />
      {space.canDelete ? (
        <Button variant="destructive-secondary" onClick={() => setConfirmingDelete(true)}>
          <Trash2 data-icon="inline-start" />
          <Trans>Delete space</Trans>
        </Button>
      ) : null}
      {confirmingDelete ? (
        <DeleteSpaceDialog
          space={space}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={onDelete}
        />
      ) : null}
    </div>
  );
}
