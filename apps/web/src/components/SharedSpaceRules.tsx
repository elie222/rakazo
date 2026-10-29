import { Trans } from "@lingui/react/macro";

/** What sharing a space means, shown where someone invites or joins. */
export function SharedSpaceRules({ className }: { className?: string }) {
  return (
    <ul
      className={["list-disc space-y-1 ps-5 text-muted-foreground", className]
        .filter(Boolean)
        .join(" ")}
    >
      <li>
        <Trans>Everyone in this space sees all its chats, bots and memory.</Trans>
      </li>
      <li>
        <Trans>Your other spaces stay private.</Trans>
      </li>
      <li>
        <Trans>
          A bot uses the accounts of whoever messages it, and anyone here can read its reply.
        </Trans>
      </li>
    </ul>
  );
}
