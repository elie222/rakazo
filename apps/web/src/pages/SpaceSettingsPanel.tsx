import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useId, useState } from "react";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import type { SettingsSpace } from "./shell/dialogs";
import { DeleteSpaceDialog } from "./shell/dialogs";

/** The space the space-scoped sections act on: its name, and deletion for its owner. */
export function SpaceSettingsPanel({
  space,
  onRename,
  onDelete,
}: {
  space: SettingsSpace;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const trimmed = draft?.trim() ?? "";

  async function save() {
    if (pending || !trimmed) return;
    // Nothing to save, so close without a request.
    if (trimmed === space.name) {
      setDraft(null);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onRename(trimmed);
      setDraft(null);
    } catch (err) {
      setError(
        err instanceof Error && err.message.trim() ? err.message : t`Could not rename space`,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-8" data-testid="space-settings">
      <SettingsGroup>
        {draft !== null ? (
          <form
            className="space-y-3 px-4 py-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                if (!pending) setDraft(null);
              }
            }}
          >
            <Field>
              <FieldLabel htmlFor={nameId}>
                <Trans>Name</Trans>
              </FieldLabel>
              <Input
                id={nameId}
                autoFocus
                maxLength={60}
                value={draft}
                disabled={pending}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError(null);
                }}
              />
            </Field>
            {error ? (
              <p role="alert" className="text-[12.5px] text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex items-center gap-3">
              <Button type="submit" className="rounded-full" disabled={pending || !trimmed}>
                <Trans>Save</Trans>
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="rounded-full"
                disabled={pending}
                onClick={() => setDraft(null)}
              >
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </form>
        ) : (
          <SettingsRow
            label={<p className="break-words">{space.name}</p>}
            control={
              space.canRename ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full"
                  aria-label={t`Rename space`}
                  onClick={() => {
                    setError(null);
                    setDraft(space.name);
                  }}
                >
                  <Trans>Edit</Trans>
                </Button>
              ) : null
            }
          />
        )}
      </SettingsGroup>
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
