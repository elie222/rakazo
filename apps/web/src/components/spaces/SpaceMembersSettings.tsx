import { Trans, useLingui } from "@lingui/react/macro";
import type { SpaceMember, SpaceMembers } from "@rakazo/contracts";
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
import { Copy, Link, Mail, MoreHorizontal, UserPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSave } from "../../lib/query/query";
import { useSpaceRpc } from "../../lib/query/space-rpc";
import { errorText } from "../../lib/query/user-error";
import { ConfirmDialog } from "../ConfirmDialog";
import { SettingsGroup } from "../settings/SettingsRows";
import { PersonRow } from "./PersonRow";

type Confirm = { kind: "remove"; member: SpaceMember } | { kind: "leave" };

export function SpaceMembersSettings({
  space,
  onLeft,
}: {
  space: { id: string; name: string };
  /** After leaving, with the space the server moved this person to. */
  onLeft: (activeSpaceId: string) => void;
}) {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const [members, setMembers] = useState<SpaceMembers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  /** The address being invited; null while the form is closed. */
  const [email, setEmail] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  /** The Space the shown list belongs to. */
  const shownSpace = useRef<string | null>(null);

  // Not keyed on `t`: a new one each render must not reload the list.
  useEffect(() => {
    let active = true;
    // Another space's people, error and link never show while this one loads; a reload of the
    // same Space after adding someone keeps showing the list it replaces.
    if (shownSpace.current !== space.id) {
      shownSpace.current = null;
      setMembers(null);
      setEmail(null);
    }
    setError(null);
    setInviteUrl(null);
    rpc.spaces.members
      .list({ spaceId: space.id })
      .then((next) => {
        if (!active) return;
        shownSpace.current = space.id;
        setMembers(next);
      })
      .catch((err: unknown) => {
        if (active) setError(errorText(err, t`Could not load members`));
      });
    return () => {
      active = false;
    };
  }, [rpc, space.id, reload]);

  /** Copies the link; only when that fails is the link shown, to copy by hand. */
  async function copy(url: string) {
    try {
      if (!navigator.clipboard) throw new Error("No clipboard");
      await navigator.clipboard.writeText(url);
      setInviteUrl(null);
      toast(t`Invite link copied`);
    } catch {
      setInviteUrl(url);
    }
  }

  async function cancelInvites() {
    setError(null);
    try {
      await rpc.spaces.invites.cancel({ spaceId: space.id });
      setInviteUrl(null);
      setMembers((current) => (current ? { ...current, openInvites: 0 } : current));
    } catch (err) {
      setError(errorText(err, t`Could not cancel invites`));
    }
  }

  async function invite() {
    if (inviting) return;
    setInviting(true);
    setError(null);
    try {
      const link = await rpc.spaces.invites.create({ spaceId: space.id });
      setMembers((current) =>
        current ? { ...current, openInvites: (current.openInvites ?? 0) + 1 } : current,
      );
      await copy(link.url);
    } catch (err) {
      setError(errorText(err, t`Could not create invite link`));
    } finally {
      setInviting(false);
    }
  }

  async function runConfirm() {
    if (!confirm || confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      if (confirm.kind === "remove") {
        const { userId } = confirm.member;
        await rpc.spaces.members.remove({ spaceId: space.id, userId });
        setMembers((current) =>
          current
            ? { ...current, members: current.members.filter((item) => item.userId !== userId) }
            : current,
        );
        // The removed person may be addable again, so the list is re-read from the server.
        setReload((value) => value + 1);
        setConfirm(null);
      } else {
        const result = await rpc.spaces.members.leave({ spaceId: space.id });
        setConfirm(null);
        onLeft(result.activeSpaceId);
      }
    } catch (err) {
      setConfirmError(
        errorText(
          err,
          confirm.kind === "remove" ? t`Could not remove member` : t`Could not leave space`,
        ),
      );
    } finally {
      setConfirming(false);
    }
  }

  const adding = useSave({
    save: (ask: { spaceId: string; userId: string }, client) => client.spaces.members.add(ask),
    onSaved: () => setReload((value) => value + 1),
  });
  const emailing = useSave({
    save: (ask: { spaceId: string; email: string }, client) => client.spaces.invites.create(ask),
    onSaved: async (sent, ask) => {
      if (ask.spaceId !== shownSpace.current) return;
      setEmail(null);
      setMembers((current) =>
        current ? { ...current, openInvites: (current.openInvites ?? 0) + 1 } : current,
      );
      if (sent.emailed) toast(t`Invitation sent`);
      else await copy(sent.url);
    },
  });
  // A failure to add or invite someone to another Space stays with that Space.
  const addError =
    adding.input?.spaceId === space.id && adding.error
      ? errorText(adding.error, t`Could not add member`)
      : emailing.input?.spaceId === space.id && emailing.error
        ? errorText(emailing.error, t`Could not invite`)
        : null;
  const invitee = members && email !== null ? spaceInvitee(members, email) : null;
  const organizationName = members?.organizationName ?? "";

  function inviteByEmail() {
    if (!invitee || email === null) return;
    if (invitee.kind === "outside") {
      emailing.run({ spaceId: space.id, email: email.trim() });
      return;
    }
    // Someone in the organization joins directly, and someone already here needs nothing.
    if (invitee.kind === "addable") adding.run({ spaceId: space.id, userId: invitee.userId });
    setEmail(null);
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
          render={<Button variant="ghost" size="sm" disabled={inviting || adding.pending} />}
        >
          {inviteLabel}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto max-w-72 min-w-44">
          {addable.map((person) => (
            <DropdownMenuItem
              key={person.userId}
              onClick={() => adding.run({ spaceId: space.id, userId: person.userId })}
            >
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
          <DropdownMenuItem onClick={() => void invite()}>
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
              disabled={inviting}
              onClick={() => void cancelInvites()}
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
      onClick={() => {
        setConfirmError(null);
        setConfirm({ kind: "leave" });
      }}
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
                    ? () => {
                        setConfirmError(null);
                        setConfirm({ kind: "remove", member });
                      }
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
      {members && (error || addError) ? (
        <p className="px-1 text-body-sm text-destructive">{error ?? addError}</p>
      ) : null}
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
              onClick={() => void copy(inviteUrl)}
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
          busy={confirming}
          onConfirm={() => void runConfirm()}
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
