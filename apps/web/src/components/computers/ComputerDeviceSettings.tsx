import { Trans, useLingui } from "@lingui/react/macro";
import type { RakazoDesktop, UserDeviceSummary } from "@rakazo/contracts";
import { secureHttpOrigin } from "@rakazo/contracts/network-host";
import { Button, Label, Switch } from "@rakazo/ui-web";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useId } from "react";
import { listUserDevices, removeUserDevice } from "../../lib/auth/user-devices";
import { desktopBridge } from "../../lib/platform/desktop";
import { useQueryUserId, useSave } from "../../lib/query/query";
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

/** The computers paired to this account; devices belong to the user, not to a Space. */
export function userDevicesQuery(userId: string | null) {
  return queryOptions({
    queryKey: [`user:${userId ?? ""}`, "userDevices"],
    queryFn: (): Promise<UserDeviceSummary[]> => listUserDevices(),
  });
}

function thisComputerQuery(userId: string | null) {
  const desktop = desktopBridge();
  return queryOptions({
    queryKey: [`user:${userId ?? ""}`, "thisComputer"],
    queryFn: () => thisComputerAccess(desktop),
    enabled: Boolean(desktop?.device || desktop?.computer?.managesHostChoice),
  });
}

/**
 * The switch that lets bots use this computer, or null where this window cannot offer it. A failed
 * read keeps the last known switch rather than hiding it.
 */
export function useThisComputer() {
  const userId = useQueryUserId();
  const query = thisComputerQuery(userId);
  return {
    thisComputer: useQuery(query).data ?? null,
    plainHttp: plainHttpDesktop(desktopBridge()),
    queryKey: query.queryKey,
  };
}

export function ComputerDeviceSettings() {
  const { t } = useLingui();
  const { thisComputer, plainHttp, queryKey: thisComputerKey } = useThisComputer();
  const queryClient = useQueryClient();
  const devicesQuery = userDevicesQuery(useQueryUserId());
  const devicesRead = useQuery(devicesQuery);
  const devices = devicesRead.data ?? [];
  const devicesFailed = !devicesRead.data && devicesRead.isError;
  const switchId = useId();

  // Neither change goes through the API: one is the desktop app's, the other a device route.
  const change = useSave({
    save: async ({ action }: { action: () => Promise<unknown>; failure: string }) => {
      await action();
    },
    stale: [devicesQuery.queryKey, thisComputerKey],
    // A failed removal or pairing may still have changed something, so both are read again.
    onFailed: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: devicesQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: thisComputerKey }),
      ]),
  });
  const pending = change.pending;

  if (devices.length === 0 && !devicesFailed && !thisComputer && !plainHttp) return null;

  return (
    <SettingsGroup title={<Trans>Your devices</Trans>} data-testid="computer-devices">
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
      {devicesFailed ? (
        <SettingsRow
          label={
            <p className="text-destructive" role="alert">
              <Trans>Could not load</Trans>
            </p>
          }
          control={
            <Button
              variant="secondary"
              size="sm"
              disabled={devicesRead.isFetching}
              onClick={() => void devicesRead.refetch()}
            >
              <Trans>Retry</Trans>
            </Button>
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
