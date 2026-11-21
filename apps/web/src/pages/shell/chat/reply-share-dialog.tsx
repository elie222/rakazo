import { Trans, useLingui } from "@lingui/react/macro";
import type { ThreadMessage } from "@rakazo/contracts";
import { sharedReplyText } from "@rakazo/core";
import { redactSensitiveText } from "@rakazo/logging/redaction";
import {
  Button,
  CopyTextFallback,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  useCopyText,
} from "@rakazo/ui-web";
import { Check } from "lucide-react";
import { useState } from "react";
import type { ArtifactTarget } from "../../../lib/pages/artifact-open";
import { spaceQueries, useQueryUserId, useSave } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";

/**
 * What one bot reply's public link will show, and the one button that makes the link and copies
 * it: no link exists until that press.
 */
export function ReplyShareDialog({
  message,
  target,
  open,
  onOpenChange,
}: {
  message: ThreadMessage;
  target: ArtifactTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const [copied, copy, copyFailed, resetCopy, copyFailedText] = useCopyText();
  // One link per dialog: pressing Copy link again copies the same link.
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const create = useSave({
    save: (_, rpc) => rpc.replyShares.create({ ...target, messageId: message.id }),
    stale: [spaceQueries(userId, null).replyShares.list.queryKey()],
    onSaved: ({ shareUrl: url }) => {
      setShareUrl(url);
      void copy(url);
    },
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="reply-share" className="gap-3">
          <DialogTitle>
            <Trans>Share reply</Trans>
          </DialogTitle>
          <p
            data-testid="reply-share-text"
            dir="auto"
            className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 text-body text-foreground"
          >
            {sharedReplyText(message, redactSensitiveText)}
          </p>
          <DialogDescription>
            <Trans>Anyone with the link can read this reply</Trans>
          </DialogDescription>
          <Button
            disabled={create.pending}
            onClick={() => (shareUrl ? void copy(shareUrl) : create.run())}
          >
            {copied ? <Check className="size-4" strokeWidth={1.8} /> : null}
            {copied ? <Trans>Copied</Trans> : <Trans>Copy link</Trans>}
          </Button>
          <span role="status" className="sr-only">
            {copied ? t`Link copied` : ""}
          </span>
          {create.error ? (
            <p role="alert" className="text-label text-destructive">
              {errorText(create.error, t`Could not continue`)}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
      <CopyTextFallback
        open={copyFailed}
        onOpenChange={resetCopy}
        text={copyFailedText}
        label={t`Reply link`}
      />
    </>
  );
}
