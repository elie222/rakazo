import { Trans, useLingui } from "@lingui/react/macro";
import type { SpaceMember } from "@rakazo/contracts";
import { accountDisplay, spaceInvitee } from "@rakazo/core";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  toast,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Copy, Link, Mail, MoreHorizontal, UserPlus } from "lucide-react";
import { useRef, useState } from "react";
import { spaceQueries, useQueryUserId, useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { useCopyInviteLink } from "../../lib/spaces/use-copy-invite-link";
import { ConfirmDialog } from "../ConfirmDialog";
import { SettingsGroup } from "../settings/SettingsRows";
import { PersonRow } from "./PersonRow";

/** A removal or a leave, with the Space it was asked for. */
type Confirm = { spaceId: string } & ({ kind: "remove"; member: SpaceMember } | { kind: "leave" });

export function SpaceMembersSettings({
  space,
  onLeft,
}: {
  space: { id: string; name: string };
  /** After leaving, with the space the server moved this person to. */
  onLeft: (activeSpaceId: string) => void;
}) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const membersQuery = (spaceId: string) =>
    spaceQueries(userId, spaceId).spaces.members.list.queryOptions({ input: { spaceId } });
  const query = useQuery(membersQuery(space.id));
  const members = query.data ?? null;
  /** A save re-reads the list of the Space it was made for, whichever is on screen by then. */
  const stale = (ask: { spaceId: string }) => [membersQuery(ask.spaceId).queryKey];
  const { manualLink: inviteUrl, copyLink, dismissManualLink } = useCopyInviteLink();
  /** The address being invited; null while the form is closed. */
  const [email, setEmail] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  /** The Space the form and link below belong to; another one's never show. */
  const [formSpace, setFormSpace] = useState(space.id);
  if (formSpace !== space.id) {
    setFormSpace(space.id);
    setEmail(null);
    setConfirm(null);
    dismissManualLink();
  }
  /** The Space on screen when a save ends. */
  const shownSpace = useRef(space.id);
  shownSpace.current = space.id;

  const linking = useSave({
    save: (ask: { spaceId: string }, client) => client.spaces.invites.create(ask),
    stale,
    onSaved: (link) => copyLink(link.url),
  });
  const cancelling = useSave({
    save: (ask: { spaceId: string }, client) => client.spaces.invites.cancel(ask),
    stale,
    onSaved: dismissManualLink,
  });
  const confirming = useSave({
    save: async (ask: Confirm, client) => {
      if (ask.kind === "leave") return client.spaces.members.leave({ spaceId: ask.spaceId });
      await client.spaces.members.remove({ spaceId: ask.spaceId, userId: ask.member.userId });
      return null;
    },
    // The removed person may be addable again, so the list is re-read from the server.
    stale: (ask) => (ask.kind === "remove" ? stale(ask) : []),
    onSaved: (left) => {
      setConfirm(null);
      if (left) onLeft(left.activeSpaceId);
    },
  });
  const adding = useSave({
    save: (ask: { spaceId: string; userId: string }, client) => client.spaces.members.add(ask),
    stale,
  });
  const emailing = useSave({
    save: (ask: { spaceId: string; email: string }, client) => client.spaces.invites.create(ask),
    stale,
    onSaved: async (sent, ask) => {
      if (ask.spaceId !== shownSpace.current) return;
      setEmail(null);
      if (sent.emailed) toast(t`Invitation sent`);
      else await copyLink(sent.url);
    },
  });
  /** The error line shows one failure: starting an action forgets the earlier ones. */
  function forgetFailures() {
    for (const save of [linking, cancelling, adding, emailing]) save.reset();
  }
  const loadError = query.error ? errorText(query.error, t`Could not load members`) : null;
  // A failure in another Space stays with that Space.
  const failed = (save: { input?: { spaceId: string }; error: Error | null }) =>
    save.input?.spaceId === space.id ? save.error : null;
  const linkingError = failed(linking);
  const cancellingError = failed(cancelling);
  const addingError = failed(adding);
  const emailingError = failed(emailing);
  // An action's failure is newer than a failed re-read, which keeps showing the list it had.
  const error =
    (linkingError
      ? errorText(linkingError, t`Could not create invite link`)
      : cancellingError
        ? errorText(cancellingError, t`Could not cancel invites`)
        : addingError
          ? errorText(addingError, t`Could not add member`)
          : emailingError
            ? errorText(emailingError, t`Could not invite`)
            : null) ?? loadError;
  const confirmError = confirming.error
    ? errorText(
        confirming.error,
        confirming.input?.kind === "remove" ? t`Could not remove member` : t`Could not leave space`,
      )
    : null;
  const invitee = members && email !== null ? spaceInvitee(members, email) : null;
  const organizationName = members?.organizationName ?? "";

  function inviteByEmail() {
    if (!invitee || email === null) return;
    if (invitee.kind === "outside") {
      forgetFailures();
      emailing.run({ spaceId: space.id, email: email.trim() });
      return;
    }
    // Someone in the organization joins directly, and someone already here needs nothing.
    if (invitee.kind === "addable") addMember(invitee.userId);
    setEmail(null);
  }
  function addMember(userId: string) {
    forgetFailures();
    adding.run({ spaceId: space.id, userId });
  }
  function openConfirm(next: Confirm) {
    confirming.reset();
    setConfirm(next);
  }
  const canManage = members?.canManage === true;
  const memberName =
    confirm?.kind === "remove" ? accountDisplay(confirm.member, confirm.member.email).label : "";
  const addable = members?.addable ?? [];
  const inviteLabel = (
    <>
      <UserPlus />
      <Trans>Invite</Trans>
    </>
  );
  const action = !members ? null : canManage ? (
    <div className="flex items-center gap-1">
      {/* People already in the organization come first; an email or a link is for anyone else. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="sm" disabled={linking.pending || adding.pending} />}
        >
          {inviteLabel}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto max-w-72 min-w-44">
          {addable.map((person) => (
            <DropdownMenuItem key={person.userId} onClick={() => addMember(person.userId)}>
              <span className="truncate">{accountDisplay(person, person.email).label}</span>
            </DropdownMenuItem>
          ))}
          {addable.length ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem
            onClick={() => {
              emailing.reset();
              setEmail("");
            }}
          >
            <Mail />
            <Trans>Invite by email</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              forgetFailures();
              linking.run({ spaceId: space.id });
            }}
          >
            <Link />
            <Trans>Copy invite link</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Rare, so it waits in a menu and only while some link is still unused. */}
      {members.openInvites ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t`More`}
            render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" />}
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-44">
            <DropdownMenuItem
              // A link still being created would outlive the cancel.
              disabled={linking.pending}
              onClick={() => {
                forgetFailures();
                cancelling.run({ spaceId: space.id });
              }}
            >
              <Trans>Cancel open invites</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      className="text-destructive hover:text-destructive"
      onClick={() => openConfirm({ kind: "leave", spaceId: space.id })}
    >
      <Trans>Leave space</Trans>
    </Button>
  );
  return (
    <div data-testid="space-members-settings" className="space-y-2">
      <SettingsGroup title={t`Members`} action={action}>
        {members ? (
          <ul className="divide-y divide-border" aria-label={t`Members`}>
            {members.members.map((member) => (
              <MemberRow
                key={member.userId}
                member={member}
                onRemove={
                  canManage && member.role !== "owner"
                    ? () => openConfirm({ kind: "remove", member, spaceId: space.id })
                    : undefined
                }
              />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-body-sm text-muted-foreground">
            {error ?? <Trans>Loading…</Trans>}
          </p>
        )}
      </SettingsGroup>
      {canManage && email !== null ? (
        <form
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            inviteByEmail();
          }}
        >
          <div className="flex gap-2">
            <Input
              size="lg"
              type="email"
              required
              autoFocus
              aria-label={t`Email`}
              placeholder={t`Email`}
              autoComplete="off"
              value={email}
              disabled={emailing.pending}
              onChange={(event) => {
                setEmail(event.target.value);
                emailing.reset();
              }}
            />
            <Button type="submit" size="lg" disabled={emailing.pending || !invitee}>
              <Trans>Invite</Trans>
            </Button>
          </div>
          {invitee?.kind === "outside" ? (
            <p className="px-1 text-body-sm text-muted-foreground">
              <Trans>Not in {organizationName}. They'll only see this Space.</Trans>
            </p>
          ) : null}
        </form>
      ) : null}
      {members && error ? <p className="px-1 text-body-sm text-destructive">{error}</p> : null}
      {canManage && inviteUrl ? (
        <InputGroup>
          <InputGroupInput
            readOnly
            aria-label={t`Invite link`}
            value={inviteUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-sm"
              aria-label={t`Copy invite link`}
              onClick={() => void copyLink(inviteUrl)}
            >
              <Copy />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      ) : null}
      {confirm ? (
        <ConfirmDialog
          onCancel={() => setConfirm(null)}
          title={
            confirm.kind === "remove" ? (
              <Trans>Remove {memberName}?</Trans>
            ) : (
              <Trans>Leave {space.name}?</Trans>
            )
          }
          error={confirmError}
          busy={confirming.pending}
          onConfirm={() => confirming.run(confirm)}
          confirmLabel={confirm.kind === "remove" ? <Trans>Remove</Trans> : <Trans>Leave</Trans>}
        />
      ) : null}
    </div>
  );
}

function MemberRow({ member, onRemove }: { member: SpaceMember; onRemove?: () => void }) {
  const { t } = useLingui();
  const name = accountDisplay(member, member.email).label;
  return (
    <PersonRow
      person={member}
      badge={
        <>
          {member.role === "owner" ? (
            <Badge variant="secondary">
              <Trans>Owner</Trans>
            </Badge>
          ) : null}
          {member.guest ? (
            <Badge variant="outline">
              <Trans>External</Trans>
            </Badge>
          ) : null}
        </>
      }
      trailing={
        onRemove ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t`Actions for ${name}`}
              render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" />}
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-36">
              <DropdownMenuItem variant="destructive" onClick={onRemove}>
                <Trans>Remove</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null
      }
    />
  );
}
