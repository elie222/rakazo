import { Trans } from "@lingui/react/macro";
import { writeSaved } from "@rakazo/core/query";
import { Label, Switch } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { SettingsGroup, SettingsRow } from "../settings/SettingsRows";

/**
 * Whether this Space keeps a short, redacted trace of each tool call. One switch decides it for
 * everyone in the Space, so only the people who may change it are shown it.
 */
export function ToolCallRecordsSetting() {
  const id = useId();
  const descriptionId = `${id}-description`;
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const read = queries.spaceSettings.keepToolCallRecords;
  const current = useQuery(read.queryOptions());
  // Writing back keeps the permission the read found: only a manager can get this far.
  const save = useSave({
    save: async ({ keeps }: { keeps: boolean }, rpc) => {
      const next = await rpc.spaceSettings.setKeepToolCallRecords({ keeps });
      await writeSaved(queryClient, read.queryKey(), () => ({ ...next, canManage: true }));
    },
  });
  const state = current.data;
  if (!state?.canManage) return null;
  return (
    <SettingsGroup>
      <SettingsRow
        label={
          <>
            <Label htmlFor={id} className="text-body font-normal text-foreground">
              <Trans>Keep tool call details</Trans>
            </Label>
            <p id={descriptionId} className="mt-0.5 text-body-sm text-muted-foreground">
              <Trans>Redacted, and deleted after 14 days</Trans>
            </p>
          </>
        }
        control={
          <Switch
            id={id}
            aria-describedby={descriptionId}
            data-testid="keep-tool-call-records"
            checked={state.keeps}
            disabled={save.pending}
            onCheckedChange={(keeps) => save.run({ keeps })}
          />
        }
      >
        {save.error ? (
          <p role="alert" className="pt-2 text-body-sm text-destructive">
            {errorText(save.error)}
          </p>
        ) : null}
      </SettingsRow>
    </SettingsGroup>
  );
}
