import { useLingui } from "@lingui/react/macro";
import { Button, CopyTextFallback } from "@rakazo/ui-web";
import { Check, Copy } from "lucide-react";
import { useCopyText } from "../lib/copy-text";

type CopyTextButtonProps = { text: string; copyLabel: string; manualCopyLabel?: string };

/** Copies the value, with a manual-copy dialog only when the caller supplies its label. */
export function CopyTextButton(props: CopyTextButtonProps) {
  // A new value gets a fresh copy state, even when it changes back to an earlier value.
  return <CopyButton key={props.text} {...props} />;
}

function CopyButton({ text, copyLabel, manualCopyLabel }: CopyTextButtonProps) {
  const { t } = useLingui();
  const [copied, copy, copyFailed, resetCopy, failedText] = useCopyText();
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={copied ? t`Copied` : copyLabel}
        onClick={() => copy(text)}
        className="text-muted-foreground"
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      {manualCopyLabel !== undefined ? (
        <CopyTextFallback
          open={copyFailed}
          onOpenChange={resetCopy}
          text={failedText}
          label={manualCopyLabel}
        />
      ) : null}
    </>
  );
}
