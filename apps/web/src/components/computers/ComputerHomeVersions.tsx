import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { COMPUTER_RUNNING_ERROR } from "@rakazo/contracts";
import { Button, RadioGroup, RadioGroupItem } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorCode, errorText } from "../../lib/query/user-error";
import { ConfirmDialog } from "../ConfirmDialog";

/**
 * Restores an earlier saved copy of the bot computer's files. Shown only once the computer has
 * one; the computer gets the chosen copy on its next start.
 */
export function ComputerHomeVersions({ botId }: { botId: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const read = queries.computer.homeVersions.queryOptions({ input: { botId } });
  const versions = useQuery(read).data ?? [];
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const labelId = useId();
  const restore = useSave({
    save: (versionId: string, rpc) => rpc.computer.restoreHomeVersion({ botId, versionId }),
    stale: [read.queryKey],
    onSaved: () => setOpen(false),
  });

  if (!versions.length) return null;
  const selected = chosen && versions.some((v) => v.id === chosen) ? chosen : versions[0]!.id;
  const formatter = new Intl.DateTimeFormat(i18n.locale || undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const error = restore.error
    ? errorCode(restore.error) === COMPUTER_RUNNING_ERROR
      ? t`Stop the computer first.`
      : errorText(restore.error, t`Could not restore files`)
    : null;

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
        <RadioGroup
          aria-label={t`Saved at`}
          value={selected}
          onValueChange={(value) => setChosen(String(value))}
          className="max-h-72 overflow-y-auto"
        >
          {versions.map((version) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: the wrapped RadioGroupItem is the control.
            <label
              key={version.id}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5 text-body text-foreground"
            >
              <RadioGroupItem value={version.id} />
              {formatter.format(new Date(version.savedAt))}
            </label>
          ))}
        </RadioGroup>
      </ConfirmDialog>
    </div>
  );
}
