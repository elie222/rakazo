import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import { SpaceMembersSettings } from "../components/SpaceMembersSettings";
import { useSave } from "../lib/query";
import type { RpcClient } from "../lib/rpc";
import { SpaceSettingOverrides } from "./SpaceSettingOverrides";
import type { SettingsSpace } from "./shell/dialogs";
import { DeleteSpaceDialog } from "./shell/dialogs";

/**
 * One space's page: its name, its members, the account settings it customizes, and deletion for
 * its owner.
 */
export function SpaceSettingsPanel({
  space,
  onRename,
  onDelete,
  onLeft,
  onClose,
  onBusyChange,
}: {
  space: SettingsSpace;
  onRename: (name: string, client: RpcClient) => Promise<void>;
  onDelete: () => Promise<void>;
  /** After leaving, with the space the server moved this person to. */
  onLeft: (activeSpaceId: string) => void;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
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
    // An empty or unchanged name keeps the current one without a request.
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
                {rename.error.message.trim() || t`Could not rename space`}
              </p>
            ) : null}
          </SettingsRow>
        </SettingsGroup>
      ) : null}
      <SpaceMembersSettings space={space} onLeft={onLeft} />
      <SpaceSettingOverrides onClose={onClose} onBusyChange={setOverridesBusy} />
      {space.canDelete ? (
        <Button
          variant="destructive"
          className="rounded-full"
          onClick={() => setConfirmingDelete(true)}
        >
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
