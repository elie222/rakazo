import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { CircleUserRound, Plus } from "lucide-react";
import { useState } from "react";
import { authClient } from "../lib/auth";
import { switchOrganization, useOrganizations } from "../lib/organizations";
import { useQueryUserId } from "../lib/query";
import { DeleteAccountForm, hasDeleteRedirectError } from "./AccountAccess";
import { CreateOrganizationDialog } from "./CreateOrganizationDialog";

/**
 * The way out before the app opens (plan choice, onboarding): log out or delete the account,
 * without reaching settings.
 */
export function AccountMenu({
  disabled,
  signingOut,
  onLogOut,
}: {
  disabled?: boolean;
  signingOut: boolean;
  onLogOut: () => void;
}) {
  const { t } = useLingui();
  const email = authClient.useSession().data?.user.email;
  const userId = useQueryUserId();
  const { organizations, activeOrganizationId } = useOrganizations();
  const [creatingOrganization, setCreatingOrganization] = useState(false);
  // An SSO sign-in to confirm deletion returns here; reopen so its error is seen.
  const [deleting, setDeleting] = useState(hasDeleteRedirectError);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t`Account`}
          data-testid="account-menu"
          disabled={disabled || signingOut}
          render={
            <Button
              variant="ghost"
              size="icon"
              className="fixed top-4 right-6 text-muted-foreground"
            />
          }
        >
          <CircleUserRound />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-48">
          {email ? (
            <>
              <DropdownMenuGroup>
                <DropdownMenuLabel>{email}</DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {organizations.length > 1 ? (
            <DropdownMenuRadioGroup
              value={activeOrganizationId}
              onValueChange={(id) => {
                const organization = organizations.find((candidate) => candidate.id === id);
                if (organization && id !== activeOrganizationId)
                  switchOrganization(userId, organization);
              }}
            >
              {organizations.map((organization) => (
                <DropdownMenuRadioItem key={organization.id} value={organization.id}>
                  <span className="min-w-0 truncate">{organization.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          ) : null}
          <DropdownMenuItem onClick={() => setCreatingOrganization(true)}>
            <Plus />
            <Trans>Create organization</Trans>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onLogOut}>
            <Trans>Log out</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDeleting(true)}>
            <Trans>Delete account</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Delete account</Trans>
            </DialogTitle>
          </DialogHeader>
          <DeleteAccountForm open />
        </DialogContent>
      </Dialog>
      <CreateOrganizationDialog
        open={creatingOrganization}
        onOpenChange={setCreatingOrganization}
      />
    </>
  );
}
