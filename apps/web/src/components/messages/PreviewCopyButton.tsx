import { useLingui } from "@lingui/react/macro";
import { Button, CopyTextFallback, useCopyText } from "@rakazo/ui-web";
import { Check, Copy } from "lucide-react";
import { IconTooltip } from "../IconTooltip";

/**
 * Copies a previewed file's own text — the Markdown source, not the rendered page. When the
 * browser refuses the clipboard, the text is offered once in a field to copy by hand.
 */
export function PreviewCopyButton({
  text,
  name,
  appearance,
}: {
  text: string;
  /** The file's name, so the accessible name says what is copied. */
  name: string;
  appearance: "icon" | "labelled";
}) {
  const { t } = useLingui();
  const [copied, copy, failed, reset, failedText] = useCopyText();
  const label = copied ? t`Copied` : t`Copy ${name}`;
  const copyNow = () => void copy(text);

  return (
    <>
      {appearance === "icon" ? (
        <IconTooltip label={label}>
          <Button
            variant="ghost"
            size="icon-lg"
            className="rounded-full text-muted-foreground"
            aria-label={label}
            onClick={copyNow}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </IconTooltip>
      ) : (
        <Button variant="outline" size="sm" aria-label={label} onClick={copyNow}>
          {copied ? (
            <Check className="me-1.5" size={15} strokeWidth={1.9} />
          ) : (
            <Copy className="me-1.5" size={15} strokeWidth={1.9} />
          )}
          {copied ? t`Copied` : t`Copy`}
        </Button>
      )}
      <CopyTextFallback
        open={failed}
        onOpenChange={(open) => {
          if (!open) reset();
        }}
        text={failedText}
        label={label}
      />
    </>
  );
}
