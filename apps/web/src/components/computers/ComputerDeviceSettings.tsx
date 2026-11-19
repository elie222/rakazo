import { Trans, useLingui } from "@lingui/react/macro";
import type { RakazoDesktop, UserDeviceSummary } from "@rakazo/contracts";
import { secureHttpOrigin } from "@rakazo/contracts/network-host";
import { Button, Label, Switch } from "@rakazo/ui-web";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { listUserDevices, removeUserDevice } from "../../lib/auth/user-devices";
import { desktopBridge } from "../../lib/platform/desktop";
import { useSave } from "../../lib/query/query";
import { rpc } from "../../lib/query/rpc";
import { SettingsGroup, SettingsRow } from "../settings/SettingsRows";

type ThisComputer = { allowed: boolean; setAllowed: (allowed: boolean) => Promise<unknown> };

/** A remote server pairs this computer; the app-managed local stack runs bots on it directly. */
async function thisComputerAccess(
  desktop: RakazoDesktop | undefined,
): Promise<ThisComputer | null> {
  const device = desktop?.device;
  const paired = await device?.state().catch(() => null);
  if (device && paired) return { allowed: paired.allowed, setAllowed: device.setAllowed };
  const computer = desktop?.computer;
  if (!computer?.managesHostChoice) return null;
  const me = await rpc.me();
  if (!me.canChooseHostComputer) return null;
  return {
    allowed: me.computerHost === "this-mac",
    setAllowed: (allowed) => (allowed ? computer.requestAccess() : computer.revokeAccess()),
  };
}

/**
 * A private-LAN HTTP page never becomes the paired computer. `select` drops that origin, so a
 * switch here would call `setAllowed` and do nothing.
 */
function plainHttpDesktop(desktop: RakazoDesktop | undefined): boolean {
  if (!desktop?.device || typeof window === "undefined") return false;
  return secureHttpOrigin(window.location.origin) === null;
}

export function ComputerDeviceSettings() {
  const { t } = useLingui();
  const desktop = desktopBridge();
  const plainHttp = plainHttpDesktop(desktop);
  const [devices, setDevices] = useState<UserDeviceSummary[]>([]);
  const [thisComputer, setThisComputer] = useState<ThisComputer | null>(null);
  const switchId = useId();

  const load = useCallback(async () => {
    const [listed, local] = await Promise.all([
      listUserDevices().catch(() => null),
      // A failed profile read keeps the last known switch rather than hiding it.
      thisComputerAccess(desktop).catch(() => undefined),
    ]);
    if (listed) setDevices(listed);
    if (local !== undefined) setThisComputer(local);
  }, [desktop]);

  useEffect(() => {
    void load();
  }, [load]);

  // Neither change goes through the API: one is the desktop app's, the other a device route.
  const change = useSave({
    save: async ({ action }: { action: () => Promise<unknown>; failure: string }) => {
      try {
        await action();
      } finally {
        await load();
      }
    },
  });
  const pending = change.pending;

  if (devices.length === 0 && !thisComputer && !plainHttp) return null;

  return (
    <SettingsGroup title={<Trans>Computers</Trans>} data-testid="computer-devices">
      {plainHttp ? (
        <p className="px-4 py-3 text-body-sm text-muted-foreground">
          <Trans>Plain HTTP does not pair this computer. Use HTTPS, or a loopback server.</Trans>
        </p>
      ) : thisComputer ? (
        <SettingsRow
          label={
            <Label htmlFor={switchId} className="text-body font-normal text-foreground">
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
                change.run({
                  action: () => thisComputer.setAllowed(allowed),
                  failure: t`Could not change`,
                })
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
              <span className="shrink-0 text-body-sm text-muted-foreground">
                {device.connected ? (
                  device.bound ? (
                    <Trans>Bound to bots</Trans>
                  ) : (
                    <Trans>Connected</Trans>
                  )
                ) : (
                  <Trans>Offline</Trans>
                )}
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
              onClick={() =>
                change.run({
                  action: () => removeUserDevice(device.deviceId),
                  failure: t`Could not remove`,
                })
              }
            >
              <Trash2 />
            </Button>
          }
        />
      ))}
      {change.error ? (
        <p role="alert" className="px-4 py-3 text-body-sm text-destructive">
          {change.input?.failure}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
