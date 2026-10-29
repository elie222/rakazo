import { Trans, useLingui } from "@lingui/react/macro";
import type { SpaceMember, SpaceMembers } from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  toast,
} from "@rakazo/ui-web";
import { Copy, MoreHorizontal, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";
import { SettingsGroup } from "./SettingsRows";
import { SharedSpaceRules } from "./SharedSpaceRules";

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
  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // Not keyed on `t`: a new one each render must not reload the list.
  useEffect(() => {
    let active = true;
    rpc.spaces.members
      .list({ spaceId: space.id })
      .then((next) => {
        if (active) setMembers(next);
      })
      .catch((err: unknown) => {
        if (active) setError(errorText(err, t`Could not load members`));
      });
    return () => {
      active = false;
    };
  }, [rpc, space.id]);

  function copy(url: string) {
    void navigator.clipboard
      ?.writeText(url)
      .then(() => toast(t`Invite link copied`))
      .catch(() => undefined);
  }

  async function invite() {
    if (inviting) return;
    setInviting(true);
    setError(null);
    try {
      const link = await rpc.spaces.invites.create({ spaceId: space.id });
      setInviteUrl(link.url);
      copy(link.url);
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

  const canManage = members?.canManage === true;
  const memberName =
    confirm?.kind === "remove" ? accountDisplay(confirm.member, confirm.member.email).label : "";
  return (
    <div data-testid="space-members-settings" className="space-y-4">
      <SettingsGroup title={t`Members`}>
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
          <p className="px-4 py-3 text-[13px] text-muted-foreground">
            {error ?? <Trans>Loading…</Trans>}
          </p>
        )}
      </SettingsGroup>
      {members && error ? <p className="px-1 text-[13px] text-destructive">{error}</p> : null}
      <SharedSpaceRules className="max-w-md px-1 text-[13px]" />
      {canManage ? (
        <div className="flex flex-col items-start gap-3">
          <Button
            variant="outline"
            className="rounded-full"
            disabled={inviting}
            onClick={() => void invite()}
          >
            <UserPlus />
            <Trans>Invite</Trans>
          </Button>
          {inviteUrl ? (
            <InputGroup className="max-w-md">
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
                  onClick={() => copy(inviteUrl)}
                >
                  <Copy />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          ) : null}
        </div>
      ) : null}
      {members && !canManage ? (
        <Button
          variant="destructive"
          className="rounded-full"
          onClick={() => {
            setConfirmError(null);
            setConfirm({ kind: "leave" });
          }}
        >
          <Trans>Leave space</Trans>
        </Button>
      ) : null}
      {confirm ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !confirming) setConfirm(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirm.kind === "remove" ? (
                  <Trans>Remove {memberName}?</Trans>
                ) : (
                  <Trans>Leave {space.name}?</Trans>
                )}
              </AlertDialogTitle>
            </AlertDialogHeader>
            {confirmError ? <p className="text-[13.5px] text-destructive">{confirmError}</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={confirming}>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={confirming}
                onClick={() => void runConfirm()}
              >
                {confirm.kind === "remove" ? <Trans>Remove</Trans> : <Trans>Leave</Trans>}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}

function MemberRow({ member, onRemove }: { member: SpaceMember; onRemove?: () => void }) {
  const { t } = useLingui();
  const display = accountDisplay(member, member.email);
  const name = display.label;
  const [failedImage, setFailedImage] = useState<string | null>(null);
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-muted text-sm font-medium text-foreground"
      >
        {display.image && failedImage !== display.image ? (
          <img
            src={display.image}
            alt=""
            className="size-full object-cover"
            onError={() => setFailedImage(display.image)}
          />
        ) : (
          display.initial
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] text-foreground">{display.label}</span>
          {member.role === "owner" ? (
            <Badge variant="secondary">
              <Trans>Owner</Trans>
            </Badge>
          ) : null}
        </div>
        {display.label !== member.email ? (
          <p className="truncate text-[13px] text-muted-foreground">{member.email}</p>
        ) : null}
      </div>
      {onRemove ? (
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
      ) : null}
    </li>
  );
}
