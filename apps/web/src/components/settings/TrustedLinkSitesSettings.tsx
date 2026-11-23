import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useTrustedLinkSites } from "../../lib/integrations/trusted-link-sites";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { SpaceRpcProvider } from "../../lib/query/space-rpc";
import { errorText } from "../../lib/query/user-error";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

/** Sites the user chose to always open from chat links; shown only once there is one. */
export function TrustedLinkSitesSettings() {
  return (
    <SpaceRpcProvider spaceId={null}>
      <TrustedLinkSitesList />
    </SpaceRpcProvider>
  );
}

function TrustedLinkSitesList() {
  const { t } = useLingui();
  const { sites, remove } = useTrustedLinkSites();
  const queries = useSpaceQueries();
  const removal = useSave({
    save: (site: string, client) => remove(site, client),
    stale: [queries.trustedLinkSites.list.queryKey()],
  });
  const error = removal.error ? errorText(removal.error, t`Could not continue`) : null;

  if (sites.length === 0) return null;
  return (
    <SettingsGroup title={<Trans>Trusted sites</Trans>} data-testid="trusted-link-sites">
      {sites.map((site) => (
        <SettingsRow
          key={site}
          label={<span className="break-all">{site}</span>}
          control={
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              aria-label={t`Remove ${site}`}
              disabled={removal.pending}
              onClick={() => removal.run(site)}
            >
              <Trans>Remove</Trans>
            </Button>
          }
        />
      ))}
      {error ? (
        <p role="alert" className="px-4 py-3 text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
