import { Trans, useLingui } from "@lingui/react/macro";
import { Button, buttonVariants, toast } from "@rakazo/ui-web";
import { Star } from "lucide-react";

// Separate keys so a count written by another tab can never undo a dismissal.
export const STAR_PROMPT_SENT_KEY = "rakazo.githubStarPrompt.sent";
export const STAR_PROMPT_DISMISSED_KEY = "rakazo.githubStarPrompt.dismissed";
export const STAR_PROMPT_FIRST_SENT_KEY = "rakazo.githubStarPrompt.firstSentAt";
const REPOSITORY_URL = "https://github.com/elie222/rakazo";
const MESSAGES_BEFORE_ASKING = 5;
const WAIT_BEFORE_ASKING_MS = 30 * 60_000;
const TOAST_ID = "github-star-prompt";

let shownThisSession = false;

function dismiss() {
  try {
    localStorage.setItem(STAR_PROMPT_DISMISSED_KEY, "1");
  } catch {}
}

/**
 * Counts a sent message and, after five and 30 minutes since the first, asks once per session
 * for a GitHub star until dismissed.
 */
export function recordMessageSent(now = Date.now()): void {
  if (shownThisSession) return;
  try {
    if (localStorage.getItem(STAR_PROMPT_DISMISSED_KEY) !== null) return;
    const sent = (Number(localStorage.getItem(STAR_PROMPT_SENT_KEY)) || 0) + 1;
    localStorage.setItem(STAR_PROMPT_SENT_KEY, String(sent));
    let firstSentAt = Number(localStorage.getItem(STAR_PROMPT_FIRST_SENT_KEY));
    if (!firstSentAt) {
      firstSentAt = now;
      localStorage.setItem(STAR_PROMPT_FIRST_SENT_KEY, String(now));
    }
    if (sent <= MESSAGES_BEFORE_ASKING || now - firstSentAt < WAIT_BEFORE_ASKING_MS) return;
  } catch {
    // Storage that cannot be written could not keep a dismissal, so never ask.
    return;
  }
  shownThisSession = true;
  toast.custom(() => <GitHubStarPrompt />, {
    id: TOAST_ID,
    // The default bottom-right corner covers the composer.
    position: "top-right",
    duration: Number.POSITIVE_INFINITY,
    onDismiss: dismiss,
  });
}

export function resetStarPromptSessionForTests() {
  shownThisSession = false;
}

function GitHubStarPrompt() {
  const { t } = useLingui();
  // Every close path saves the dismissal, so the prompt never returns.
  const close = () => {
    dismiss();
    toast.dismiss(TOAST_ID);
  };
  return (
    <aside
      aria-label={t`Star on GitHub`}
      className="w-full rounded-xl border border-warning bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <Star aria-hidden className="size-4 fill-current text-warning" strokeWidth={1.75} />
        <Trans>Enjoying Rakazo?</Trans>
      </p>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={close}>
          <Trans>Not now</Trans>
        </Button>
        <a
          className={buttonVariants()}
          href={REPOSITORY_URL}
          target="_blank"
          rel="noreferrer"
          onClick={close}
        >
          <Trans>Star on GitHub</Trans>
        </a>
      </div>
    </aside>
  );
}
