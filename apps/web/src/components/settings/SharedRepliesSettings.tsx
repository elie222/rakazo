import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { spaceQueries, useQueryUserId, useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

/** Every bot reply the user shared by link, in any Space; shown only once there is one. */
export function SharedRepliesSettings() {
  const { t, i18n } = useLingui();
  const userId = useQueryUserId();
  // The user's own links in every Space, so one list per user, read with no Space selected.
  const queries = spaceQueries(userId, null).replyShares.list;
  const shares = useQuery({ ...queries.queryOptions(), enabled: userId !== null }).data ?? [];
  const remove = useSave({
    save: (shareId: string, rpc) => rpc.replyShares.remove({ shareId }),
    stale: [queries.queryKey()],
  });

  if (shares.length === 0) return null;
  const date = new Intl.DateTimeFormat(i18n.locale || undefined, { dateStyle: "medium" });
  return (
    <SettingsGroup title={<Trans>Shared links</Trans>} data-testid="shared-replies">
      {shares.map((share) => (
        <SettingsRow
          key={share.id}
          label={
            <span className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{share.botName}</span>
                <time
                  dateTime={share.createdAt}
                  className="shrink-0 text-body-sm text-muted-foreground"
                >
                  {date.format(new Date(share.createdAt))}
                </time>
              </span>
              <span className="truncate text-body-sm text-muted-foreground">{share.preview}</span>
            </span>
          }
          control={
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              aria-label={t`Remove link to ${share.botName}'s reply`}
              disabled={remove.pending}
              onClick={() => remove.run(share.id)}
            >
              <Trans>Remove</Trans>
            </Button>
          }
        />
      ))}
      {remove.error ? (
        <p role="alert" className="px-4 py-3 text-body-sm text-destructive">
          {errorText(remove.error, t`Could not continue`)}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
