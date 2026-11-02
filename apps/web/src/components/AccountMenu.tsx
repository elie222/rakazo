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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { CircleUserRound } from "lucide-react";
import { useState } from "react";
import { authClient } from "../lib/auth";
import { DeleteAccountForm, hasDeleteRedirectError } from "./AccountAccess";

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
    </>
  );
}
