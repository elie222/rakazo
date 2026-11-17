import { Trans, useLingui } from "@lingui/react/macro";
import type {
  OrganizationInvitation,
  OrganizationMember,
  OrganizationMembers,
} from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import {
  Badge,
  Button,
  CopyTextFallback,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  toast,
  writeClipboard,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { useQueryUserId, useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import type { Organization } from "../../lib/spaces/organizations";
import { organizationMembersQuery, organizationsQuery } from "../../lib/spaces/organizations";
import { ConfirmDialog } from "../ConfirmDialog";
import { SettingsPageHeader } from "../settings/SettingsPageHeader";
import { SettingsGroup } from "../settings/SettingsRows";
import { PersonRow } from "./PersonRow";

type Change =
  | { kind: "role"; member: OrganizationMember; role: "admin" | "member" }
  | { kind: "remove"; member: OrganizationMember }
  | { kind: "cancel"; invitation: OrganizationInvitation };

/** Everyone in the organization; its owner and admins also invite, change roles and remove. */
export function OrganizationMembersSettings({
  organization,
  onBack,
}: {
  organization: Organization;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const organizationId = organization.id;
  const query = useQuery(organizationMembersQuery(userId, organizationId));
  // The organization list holds the member count, and its key prefixes this list's.
  const stale = [organizationsQuery(userId).queryKey];
  const [email, setEmail] = useState("");
  const [removing, setRemoving] = useState<OrganizationMember | null>(null);
  /** A link the browser would not copy, offered to copy by hand. */
  const [manualLink, setManualLink] = useState<string | null>(null);

  async function copyLink(url: string) {
    if (await writeClipboard(url)) toast(t`Invite link copied`);
    else setManualLink(url);
  }

  const invite = useSave({
    save: (address: string, rpc) =>
      rpc.organizations.invitations.create({ organizationId, email: address }),
    stale,
    onSaved: async (sent) => {
      setEmail("");
      if (sent.emailed) toast(t`Invitation sent`);
      else await copyLink(sent.url);
    },
  });
  const change = useSave({
    save: async (ask: Change, rpc) => {
      if (ask.kind === "cancel") {
        await rpc.organizations.invitations.cancel({
          organizationId,
          invitationId: ask.invitation.id,
        });
      } else if (ask.kind === "remove") {
        await rpc.organizations.members.remove({ organizationId, userId: ask.member.userId });
      } else {
        await rpc.organizations.members.setRole({
          organizationId,
          userId: ask.member.userId,
          role: ask.role,
        });
      }
    },
    stale,
    onSaved: () => setRemoving(null),
  });

  const members: OrganizationMembers | undefined = query.data;
  const canManage = members?.canManage === true;
  const removingName = removing ? accountDisplay(removing, removing.email).label : "";

  return (
    <div className="space-y-6" data-testid="organization-members">
      <SettingsPageHeader title={t`Members`} onBack={onBack} />
      {canManage ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const address = email.trim();
            if (address) invite.run(address);
          }}
        >
          <Input
            type="email"
            required
            aria-label={t`Email`}
            placeholder={t`Email`}
            autoComplete="off"
            value={email}
            disabled={invite.pending}
            onChange={(event) => {
              setEmail(event.target.value);
              invite.reset();
            }}
          />
          <Button type="submit" size="lg" disabled={invite.pending || !email.trim()}>
            <Trans>Invite</Trans>
          </Button>
        </form>
      ) : null}
      {invite.error ? (
        <p role="alert" className="-mt-4 text-body-sm text-destructive">
          {errorText(invite.error, t`Could not invite`)}
        </p>
      ) : null}
      <SettingsGroup>
        {members ? (
          <ul className="divide-y divide-border" aria-label={t`Members`}>
            {members.members.map((member) => (
              <PersonRow
                key={member.userId}
                person={member}
                badge={<RoleBadge role={member.role} />}
                trailing={
                  member.manageable ? (
                    <RowMenu label={accountDisplay(member, member.email).label}>
                      {member.roleChangeable ? (
                        <>
                          <DropdownMenuItem
                            disabled={change.pending}
                            onClick={() =>
                              change.run({
                                kind: "role",
                                member,
                                role: member.role === "admin" ? "member" : "admin",
                              })
                            }
                          >
                            {member.role === "admin" ? (
                              <Trans>Make member</Trans>
                            ) : (
                              <Trans>Make admin</Trans>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </>
                      ) : null}
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => {
                          change.reset();
                          setRemoving(member);
                        }}
                      >
                        <Trans>Remove</Trans>
                      </DropdownMenuItem>
                    </RowMenu>
                  ) : null
                }
              />
            ))}
            {members.invitations.map((invitation) => (
              <PersonRow
                key={invitation.id}
                person={{ name: "", email: invitation.email, image: null }}
                badge={
                  <Badge variant="outline">
                    <Trans>Invited</Trans>
                  </Badge>
                }
                trailing={
                  <RowMenu label={invitation.email}>
                    <DropdownMenuItem onClick={() => void copyLink(invitation.url)}>
                      <Trans>Copy invite link</Trans>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={change.pending}
                      onClick={() => change.run({ kind: "cancel", invitation })}
                    >
                      <Trans>Cancel invitation</Trans>
                    </DropdownMenuItem>
                  </RowMenu>
                }
              />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-body-sm text-muted-foreground">
            {query.error ? (
              errorText(query.error, t`Could not load members`)
            ) : (
              <Trans>Loading…</Trans>
            )}
          </p>
        )}
      </SettingsGroup>
      {change.error && !removing ? (
        <p role="alert" className="text-body-sm text-destructive">
          {errorText(change.error)}
        </p>
      ) : null}
      {removing ? (
        <ConfirmDialog
          onCancel={() => setRemoving(null)}
          title={<Trans>Remove {removingName}?</Trans>}
          description={<Trans>Spaces only they use pass to you.</Trans>}
          error={change.error ? errorText(change.error, t`Could not remove member`) : null}
          busy={change.pending}
          onConfirm={() => change.run({ kind: "remove", member: removing })}
          confirmLabel={<Trans>Remove</Trans>}
        />
      ) : null}
      <CopyTextFallback
        open={manualLink !== null}
        onOpenChange={(open) => {
          if (!open) setManualLink(null);
        }}
        text={manualLink ?? ""}
        label={t`Invite link`}
      />
    </div>
  );
}

function RoleBadge({ role }: { role: OrganizationMember["role"] }) {
  if (role === "member") return null;
  return (
    <Badge variant="secondary">
      {role === "owner" ? <Trans>Owner</Trans> : <Trans>Admin</Trans>}
    </Badge>
  );
}

function RowMenu({ label, children }: { label: string; children: React.ReactNode }) {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`Actions for ${label}`}
        render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" />}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-40">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
