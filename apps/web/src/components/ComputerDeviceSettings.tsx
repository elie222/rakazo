import { Trans, useLingui } from "@lingui/react/macro";
import type { RakazoDesktopDevice, UserDeviceSummary } from "@rakazo/contracts";
import { Button, Label, Switch } from "@rakazo/ui-web";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { listUserDevices, removeUserDevice } from "../lib/user-devices";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

export function ComputerDeviceSettings() {
  const { t } = useLingui();
  const desktop = desktopBridge()?.device;
  const [devices, setDevices] = useState<UserDeviceSummary[]>([]);
  const [thisComputer, setThisComputer] = useState<RakazoDesktopDevice | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switchId = useId();

  const load = useCallback(async () => {
    const [listed, local] = await Promise.all([
      listUserDevices().catch(() => null),
      desktop?.state().catch(() => null) ?? null,
    ]);
    if (listed) setDevices(listed);
    setThisComputer(local);
  }, [desktop]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, failure: string) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch {
      setError(failure);
    } finally {
      await load();
      setPending(false);
    }
  }

  if (devices.length === 0 && !thisComputer) return null;

  return (
    <SettingsGroup title={<Trans>Computers</Trans>} data-testid="computer-devices">
      {thisComputer ? (
        <SettingsRow
          label={
            <Label htmlFor={switchId} className="text-[14px] font-normal text-foreground">
              <Trans>Let bots use this computer</Trans>
            </Label>
          }
          control={
            <Switch
              id={switchId}
              data-testid="this-computer-toggle"
              checked={thisComputer.allowed}
              disabled={pending}
              onCheckedChange={(allowed) =>
                void run(() => desktop!.setAllowed(allowed), t`Could not change`)
              }
            />
          }
        />
      ) : null}
      {devices.map((device) => (
        <SettingsRow
          key={device.deviceId}
          label={
            <p className="flex min-w-0 items-baseline gap-2">
              <span className="truncate">{device.name}</span>
              <span className="shrink-0 text-[12.5px] text-muted-foreground">
                {device.connected ? <Trans>Connected</Trans> : <Trans>Offline</Trans>}
              </span>
            </p>
          }
          control={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Remove ${device.name}`}
              disabled={pending}
              className="text-destructive hover:text-destructive"
              onClick={() => void run(() => removeUserDevice(device.deviceId), t`Could not remove`)}
            >
              <Trash2 />
            </Button>
          }
        />
      ))}
      {error ? (
        <p role="alert" className="px-4 py-3 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
