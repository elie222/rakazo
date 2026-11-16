import { Trans, useLingui } from "@lingui/react/macro";
import { canDeleteOrganization } from "@rakazo/core";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { Plus } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CreateOrganizationDialog } from "../components/CreateOrganizationDialog";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import type { Organization } from "../lib/organizations";
import { organizationsQuery, useOrganizations } from "../lib/organizations";
import { useQueryUserId, useSave } from "../lib/query";
import { clearSpaceSelection, rpc, selectSpace } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/** The organization the app is showing: its name, and, for its owner, renaming and deletion. */
export function OrganizationSettingsPanel({
  onBusyChange,
}: {
  onBusyChange?: (busy: boolean) => void;
}) {
  const { organizations, activeOrganizationId } = useOrganizations();
  const organization = organizations.find((candidate) => candidate.id === activeOrganizationId);
  if (!organization) return null;
  return (
    <OrganizationSettings
      key={organization.id}
      organization={organization}
      canDelete={canDeleteOrganization(organizations, organization)}
      onBusyChange={onBusyChange}
    />
  );
}

function OrganizationSettings({
  organization,
  canDelete,
  onBusyChange,
}: {
  organization: Organization;
  canDelete: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const userId = useQueryUserId();
  const nameId = useId();
  const [draft, setDraft] = useState(organization.name);
  const rename = useSave({
    save: (name: string, rpc) =>
      rpc.organizations.rename({ organizationId: organization.id, name }),
    stale: [organizationsQuery(userId).queryKey],
    onSaved: (_renamed, name) => setDraft(name),
  });
  const pending = rename.pending;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    onBusyChange?.(pending);
  }, [pending, onBusyChange]);

  function save() {
    const trimmed = draft.trim();
    if (pending) return;
    if (!trimmed || trimmed === organization.name) {
      setDraft(organization.name);
      rename.reset();
      return;
    }
    rename.run(trimmed);
  }

  return (
    <div className="space-y-8" data-testid="organization-settings">
      <SettingsGroup>
        <SettingsRow
          label={
            organization.canManage ? (
              <label htmlFor={nameId}>
                <Trans>Name</Trans>
              </label>
            ) : (
              <Trans>Name</Trans>
            )
          }
          control={
            organization.canManage ? (
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
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    setDraft(organization.name);
                    rename.reset();
                  }
                }}
              />
            ) : (
              <p className="break-words text-body">{organization.name}</p>
            )
          }
        >
          {rename.error ? (
            <p role="alert" className="pt-2 text-body-sm text-destructive">
              {errorText(rename.error)}
            </p>
          ) : null}
        </SettingsRow>
      </SettingsGroup>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="rounded-full" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          <Trans>Create organization</Trans>
        </Button>
        {canDelete ? (
          <Button
            variant="destructive"
            className="rounded-full"
            onClick={() => setConfirmingDelete(true)}
          >
            <Trans>Delete organization</Trans>
          </Button>
        ) : null}
      </div>
      <CreateOrganizationDialog open={creating} onOpenChange={setCreating} />
      {confirmingDelete ? (
        <DeleteOrganizationDialog
          organization={organization}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => removeOrganization(organization)}
        />
      ) : null}
    </div>
  );
}

/** Deletes it, then reloads into the Space the server chose. */
export async function removeOrganization(organization: Organization): Promise<void> {
  const { activeSpaceId } = await rpc.organizations.remove({ organizationId: organization.id });
  if (!selectSpace(activeSpaceId)) clearSpaceSelection();
  window.location.assign("/");
}

export function DeleteOrganizationDialog({
  organization,
  onCancel,
  onConfirm,
}: {
  organization: Organization;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useLingui();
  const confirmId = useId();
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = organization.name;
  return (
    <ConfirmDialog
      onCancel={onCancel}
      title={<Trans>Delete {organization.name}?</Trans>}
      description={<Trans>This cannot be undone.</Trans>}
      error={error}
      busy={deleting}
      confirmDisabled={typed !== name}
      onConfirm={() => {
        setDeleting(true);
        setError(null);
        void onConfirm().catch((reason: unknown) => {
          setError(errorText(reason));
          setDeleting(false);
        });
      }}
      confirmLabel={deleting ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
    >
      <Field>
        <FieldLabel htmlFor={confirmId} className="break-words">
          {t`Type ${name} to confirm`}
        </FieldLabel>
        <Input
          id={confirmId}
          value={typed}
          disabled={deleting}
          autoComplete="off"
          onChange={(event) => setTyped(event.target.value)}
        />
      </Field>
    </ConfirmDialog>
  );
}
