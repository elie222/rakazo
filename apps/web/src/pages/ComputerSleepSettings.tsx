import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ComputerSleepPolicy, ComputerStatus } from "@rakazo/contracts";
import { NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useId, useState } from "react";
import { rpc } from "../lib/rpc";

export function ComputerSleepSettings({
  botId,
  computer,
  onChanged,
}: {
  botId: string;
  computer: ComputerStatus;
  onChanged: (computer: ComputerStatus) => void;
}) {
  const [saving, setSaving] = useState(false);
  const selectId = useId();
  const [failed, setFailed] = useState(false);
  // Optional preference: keep it on this panel, closed until Advanced is opened.
  return (
    <details data-testid="computer-advanced" className="group mt-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-muted-foreground">
        <span className="text-muted-foreground">
          <Trans>Advanced</Trans>
        </span>
        <span aria-hidden="true" className="transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="mt-3 flex flex-col gap-1.5 text-sm">
        <label htmlFor={selectId} className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">
            <Trans>Keep awake</Trans>
          </span>
          <NativeSelect
            id={selectId}
            aria-label={t`Keep awake`}
            value={computer.sleepPolicy ?? "automatic"}
            disabled={saving}
            onChange={async (event) => {
              setSaving(true);
              setFailed(false);
              try {
                onChanged(
                  await rpc.computer.setSleepPolicy({
                    botId,
                    policy: event.target.value as ComputerSleepPolicy,
                  }),
                );
              } catch {
                setFailed(true);
              } finally {
                setSaving(false);
              }
            }}
          >
            <NativeSelectOption value="automatic">
              <Trans>While viewing</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="app_open">
              <Trans>While app is open</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="always">
              <Trans>Always</Trans>
            </NativeSelectOption>
          </NativeSelect>
        </label>
        {failed ? (
          <p role="alert" className="text-destructive">
            <Trans>Could not save sleep setting</Trans>
          </p>
        ) : null}
      </div>
    </details>
  );
}
