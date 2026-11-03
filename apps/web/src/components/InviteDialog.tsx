import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { BillingStatus } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from "@rakazo/ui-web";
import { Check, Copy } from "lucide-react";
import { useCopyText } from "../lib/copy-text";

type Referral = NonNullable<BillingStatus["referral"]>;

export function InviteDialog({
  referral,
  open,
  onOpenChange,
}: {
  referral: Referral;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const [copied, copy] = useCopyText();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>Invite friends</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Get a free month for each friend who starts a trial.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            aria-label={t`Invite link`}
            value={referral.url}
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button variant="outline" onClick={() => copy(referral.url)}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
          </Button>
        </div>
        {referral.rewards > 0 ? (
          <p className="text-sm text-muted-foreground">
            <Plural
              value={referral.rewards}
              one="# free month earned"
              other="# free months earned"
            />
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
