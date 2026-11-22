import { useLingui } from "@lingui/react/macro";
import { toast, writeClipboard } from "@rakazo/ui-web";
import { useState } from "react";

/**
 * Copies an invite link and says so. `manualLink` is the last link the browser would not copy,
 * offered to copy by hand until it is dismissed or a later copy works.
 */
export function useCopyInviteLink() {
  const { t } = useLingui();
  const [manualLink, setManualLink] = useState<string | null>(null);
  async function copyLink(url: string) {
    if (await writeClipboard(url)) {
      setManualLink(null);
      toast(t`Invite link copied`);
    } else setManualLink(url);
  }
  return { manualLink, copyLink, dismissManualLink: () => setManualLink(null) };
}
