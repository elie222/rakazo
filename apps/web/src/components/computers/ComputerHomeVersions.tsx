import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { homeVersionChoices } from "@rakazo/core";
import { Button, RadioGroup, RadioGroupItem } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { ConfirmDialog } from "../ConfirmDialog";

/**
 * Restores an earlier saved copy of the bot computer's files. Shown only once the computer has
 * one; the computer gets the chosen copy on its next start.
 */
export function ComputerHomeVersions({ botId }: { botId: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const read = queries.computer.homeVersions.queryOptions({ input: { botId } });
  const listing = useQuery(read);
  const versions = homeVersionChoices(listing.data ?? [], i18n.locale);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const labelId = useId();
  const restore = useSave({
    save: (versionId: string, rpc) => rpc.computer.restoreHomeVersion({ botId, versionId }),
    stale: [read.queryKey],
    onSaved: () => setOpen(false),
  });

  if (listing.isError)
    return (
      <div className="flex min-h-12 items-center justify-between gap-3 text-body text-foreground">
        <Trans>Computer files</Trans>
        <span className="text-body-sm text-destructive">
          <Trans>Could not load</Trans>
        </span>
      </div>
    );
  if (!versions.length) return null;
  const selected = chosen && versions.some((v) => v.key === chosen) ? chosen : versions[0]!.key;
  const error = restore.error ? errorText(restore.error, t`Could not restore files`) : null;

  return (
    <div className="flex min-h-12 items-center justify-between gap-3 text-body text-foreground">
      <span id={labelId}>
        <Trans>Computer files</Trans>
      </span>
      <Button
        variant="outline"
        size="sm"
        aria-describedby={labelId}
        onClick={() => {
          restore.reset();
          setChosen(null);
          setOpen(true);
        }}
      >
        <Trans>Restore earlier version</Trans>
      </Button>
      <ConfirmDialog
        open={open}
        onCancel={() => setOpen(false)}
        busy={restore.pending}
        variant="default"
        title={<Trans>Restore earlier version</Trans>}
        description={
          <Trans>
            The computer gets the files from the chosen time when it next starts. Its current files
            stay restorable.
          </Trans>
        }
        error={error}
        confirmLabel={restore.pending ? <Trans>Restoring…</Trans> : <Trans>Restore</Trans>}
        onConfirm={() => restore.run(selected)}
      >
        <div className="max-h-72 overflow-y-auto">
          <RadioGroup
            aria-label={t`Saved at`}
            value={selected}
            onValueChange={(value) => setChosen(String(value))}
          >
            {versions.map((version) => (
              // biome-ignore lint/a11y/noLabelWithoutControl: the wrapped RadioGroupItem is the control.
              <label
                key={version.key}
                className="flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5 text-body text-foreground"
              >
                <RadioGroupItem value={version.key} />
                {version.label}
              </label>
            ))}
          </RadioGroup>
        </div>
      </ConfirmDialog>
    </div>
  );
}
