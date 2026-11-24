import { Trans, useLingui } from "@lingui/react/macro";
import { canDeleteOrganization, canManageOrganizationMembers } from "@rakazo/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FieldLabel,
  Input,
} from "@rakazo/ui-web";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { AuditLog } from "../../components/audit/AuditLog";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { SettingsGroup, SettingsRow } from "../../components/settings/SettingsRows";
import { OrganizationMembersSettings } from "../../components/spaces/OrganizationMembersSettings";
import { useQueryUserId, useSave } from "../../lib/query/query";
import { clearSpaceSelection, rpc, selectSpace } from "../../lib/query/rpc";
import { errorText } from "../../lib/query/user-error";
import type { Organization } from "../../lib/spaces/organizations";
import { organizationsQuery, useOrganizations } from "../../lib/spaces/organizations";

export type OrganizationPage = "main" | "members" | "log";

/** The organization the app is showing: its name, its members and, for its owner, renaming. */
export function OrganizationSettingsPanel({
  page,
  onPageChange,
  onBusyChange,
}: {
  page: OrganizationPage;
  onPageChange: (page: OrganizationPage) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { organizations, activeOrganizationId } = useOrganizations();
  const organization = organizations.find((candidate) => candidate.id === activeOrganizationId);
  if (!organization) return null;
  return (
    <OrganizationSettings
      key={organization.id}
      organization={organization}
      page={page}
      onPageChange={onPageChange}
      onBusyChange={onBusyChange}
    />
  );
}

/** In the page header: the organization's activity log and, when allowed, its deletion. */
export function OrganizationOptionsMenu({ onActivityLog }: { onActivityLog: () => void }) {
  const { t } = useLingui();
  const { organizations, activeOrganizationId } = useOrganizations();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const organization = organizations.find((candidate) => candidate.id === activeOrganizationId);
  if (!organization) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={t`Organization options`}
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[200px]">
          <DropdownMenuItem onClick={onActivityLog}>
            <Trans>Activity log</Trans>
          </DropdownMenuItem>
          {canDeleteOrganization(organizations, organization) ? (
            <DropdownMenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
              <Trans>Delete organization</Trans>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmingDelete ? (
        <DeleteOrganizationDialog
          organization={organization}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => removeOrganization(organization)}
        />
      ) : null}
    </>
  );
}

function OrganizationSettings({
  organization,
  page,
  onPageChange,
  onBusyChange,
}: {
  organization: Organization;
  page: OrganizationPage;
  onPageChange: (page: OrganizationPage) => void;
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

  if (page === "log")
    return (
      <AuditLog
        organizationId={organization.id}
        spaceId={organization.defaultSpaceId}
        onBack={() => onPageChange("main")}
      />
    );

  if (page === "members")
    return (
      <OrganizationMembersSettings
        organization={organization}
        onBack={() => onPageChange("main")}
      />
    );

  // Alone in it, its owner is offered to invite someone instead of a count of one.
  const inviteFirst = organization.memberCount === 1 && canManageOrganizationMembers(organization);
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
        <button
          type="button"
          className="flex min-h-15 w-full items-center justify-between gap-4 rounded-b-xl px-4 py-3 text-start hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          onClick={() => onPageChange("members")}
        >
          <span className="text-body text-foreground">
            <Trans>Members</Trans>
          </span>
          <span className="flex items-center gap-1 text-body text-muted-foreground">
            {inviteFirst ? <Trans>Invite people</Trans> : organization.memberCount}
            <ChevronRight aria-hidden="true" className="size-4 rtl:rotate-180" />
          </span>
        </button>
      </SettingsGroup>
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
