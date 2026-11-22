import { useLingui } from "@lingui/react/macro";
import { toast, writeClipboard } from "@rakazo/ui-web";
import { useRef, useState } from "react";

/**
 * Copies an invite link and says so. `manualLink` is the last link the browser would not copy,
 * offered to copy by hand until it is dismissed or a later copy works. Dismissing also drops a
 * copy still in progress, so a link cancelled meanwhile never comes back.
 */
export function useCopyInviteLink() {
  const { t } = useLingui();
  const [manualLink, setManualLink] = useState<string | null>(null);
  /** Counts copies and dismissals: only the newest copy may show its outcome. */
  const latest = useRef(0);
  async function copyLink(url: string) {
    const attempt = ++latest.current;
    const isCurrent = () => latest.current === attempt;
    const copied = await writeClipboard(url, isCurrent);
    if (!isCurrent()) return;
    if (copied) {
      setManualLink(null);
      toast(t`Invite link copied`);
    } else setManualLink(url);
  }
  function dismissManualLink() {
    latest.current += 1;
    setManualLink(null);
  }
  return { manualLink, copyLink, dismissManualLink };
}
