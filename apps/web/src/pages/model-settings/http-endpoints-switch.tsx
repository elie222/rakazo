import { Trans, useLingui } from "@lingui/react/macro";
import { Label, Switch } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { rpc } from "../../lib/query/rpc";

/**
 * The deployment's plain-HTTP model endpoints switch, shown to admins where they hit the
 * HTTPS refusal: inside the compatible endpoint's Advanced section. The server re-checks the
 * setting on every connect and every run.
 */
export function HttpEndpointsSwitch() {
  const { t } = useLingui();
  const id = useId();
  const queries = useSpaceQueries();
  const me = useQuery({ queryKey: queries.me.queryKey(), queryFn: () => rpc.me() });
  const setting = useQuery({
    enabled: me.data?.isAdmin === true,
    queryKey: queries.models.httpEndpointsAllowed.queryKey(),
    queryFn: () => rpc.models.httpEndpointsAllowed(),
  });
  const save = useSave({
    save: async (allowed: boolean, client) => {
      await client.models.setHttpEndpointsAllowed({ allowed });
    },
    stale: [queries.models.httpEndpointsAllowed.key()],
  });
  if (me.data?.isAdmin !== true) return null;
  return (
    <div className="mt-4" data-testid="http-endpoints-switch">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor={id} className="text-body font-normal text-foreground">
          <Trans>Allow plain-HTTP endpoints</Trans>
        </Label>
        <Switch
          id={id}
          aria-describedby={`${id}-description`}
          data-testid="http-endpoints-toggle"
          checked={setting.data?.allowed === true}
          disabled={setting.isPending || setting.isError || save.pending}
          onCheckedChange={(checked) => save.run(checked)}
        />
      </div>
      {setting.isError ? (
        <p role="alert" className="mt-1 text-body-sm text-destructive">
          {t`Couldn't load this setting`}
        </p>
      ) : null}
      <p id={`${id}-description`} className="mt-0.5 text-body-sm text-muted-foreground">
        <Trans>
          Members can connect model servers that do not use TLS. API keys are sent to those servers
          unencrypted; only enable this on a trusted network.
        </Trans>
      </p>
      {save.error ? (
        <p role="alert" className="mt-1 text-body-sm text-destructive">
          {t`Couldn't update this setting`}
        </p>
      ) : null}
    </div>
  );
}
