import { Trans, useLingui } from "@lingui/react/macro";
import { useMobileDeviceRows } from "@rakazo/chat-ui/hooks";
import type { RakazoDesktop, UserDeviceSummary } from "@rakazo/contracts";
import { secureHttpOrigin } from "@rakazo/contracts/network-host";
import { mobileDeviceName } from "@rakazo/i18n/computer-usage";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
  Label,
  Switch,
} from "@rakazo/ui-web";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Monitor, Smartphone, Trash2 } from "lucide-react";
import { useId } from "react";
import { listUserDevices, removeUserDevice } from "../../lib/auth/user-devices";
import { desktopBridge } from "../../lib/platform/desktop";
import { spaceQueries, useQueryUserId, useSave } from "../../lib/query/query";
import { rpc } from "../../lib/query/rpc";
import { SettingsGroup, SettingsRow } from "../settings/SettingsRows";

const DEVICE_ACTION_SLOT = "w-24 shrink-0";

type ThisComputer = {
  deviceId: string | null;
  name?: string;
  local?: boolean;
  allowed: boolean;
  setAllowed: (allowed: boolean) => Promise<unknown>;
};

/** A remote server pairs this computer; the app-managed local stack runs bots on it directly. */
async function thisComputerAccess(
  desktop: RakazoDesktop | undefined,
): Promise<ThisComputer | null> {
  const device = desktop?.device;
  const paired = await device?.state().catch(() => null);
  if (device && paired) return { ...paired, setAllowed: device.setAllowed };
  const computer = desktop?.computer;
  if (!computer?.managesHostChoice) return null;
  const me = await rpc.me();
  if (!me.canChooseHostComputer) return null;
  return {
    deviceId: null,
    local: true,
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

function userDevicesQuery(userId: string | null) {
  return queryOptions({
    queryKey: [`user:${userId ?? ""}`, "userDevices"],
    queryFn: (): Promise<UserDeviceSummary[]> => listUserDevices(),
    refetchOnWindowFocus: "always",
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

function DeviceIdentity({
  name,
  bound,
  phone = false,
}: {
  name: string;
  bound?: boolean;
  phone?: boolean;
}) {
  const Icon = phone ? Smartphone : Monitor;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 break-words">{name}</span>
      {bound ? (
        <span className="text-body-sm text-muted-foreground">
          <Trans>Bound to bots</Trans>
        </span>
      ) : null}
    </div>
  );
}

function DeviceStatus({ connected }: { connected: boolean }) {
  return (
    <span className="inline-flex w-20 shrink-0 items-center gap-2 text-body-sm text-muted-foreground">
      <span
        aria-hidden="true"
        className={
          connected ? "size-2 rounded-full bg-success" : "size-2 rounded-full bg-destructive"
        }
      />
      {connected ? <Trans>Online</Trans> : <Trans>Offline</Trans>}
    </span>
  );
}

function ComputerRow({
  name,
  connected,
  bound,
  access,
  pending,
  onRemove,
}: {
  name: string;
  connected?: boolean;
  bound?: boolean;
  access?: { allowed: boolean; onChange: (allowed: boolean) => void };
  pending: boolean;
  onRemove?: () => void;
}) {
  const { t } = useLingui();
  const switchId = useId();
  return (
    <Collapsible data-testid="computer-device-row">
      <SettingsRow
        label={<DeviceIdentity name={name} bound={bound && connected} />}
        control={
          <>
            {connected !== undefined ? <DeviceStatus connected={connected} /> : null}
            <CollapsibleTrigger
              aria-label={t`Manage ${name}`}
              render={
                <Button
                  variant="text"
                  size="sm"
                  className={cn("group/manage justify-end", DEVICE_ACTION_SLOT)}
                />
              }
            >
              <Trans>Manage</Trans>
              <ChevronDown aria-hidden="true" className="group-aria-expanded/manage:rotate-180" />
            </CollapsibleTrigger>
          </>
        }
      />
      <CollapsibleContent>
        <div className="border-t border-border ps-6">
          {access ? (
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
                  checked={access.allowed}
                  disabled={pending}
                  onCheckedChange={access.onChange}
                />
              }
            />
          ) : null}
          {onRemove ? (
            <SettingsRow
              label={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t`Remove ${name}`}
                  disabled={pending}
                  className="px-0 text-destructive hover:text-destructive"
                  onClick={onRemove}
                >
                  <Trash2 aria-hidden="true" />
                  <Trans>Remove device</Trans>
                </Button>
              }
            />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ComputerDeviceSettings() {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const desktopAccess = thisComputerQuery(userId);
  const thisComputer = useQuery(desktopAccess).data ?? null;
  const plainHttp = plainHttpDesktop(desktopBridge());
  const queryClient = useQueryClient();
  const devicesQuery = userDevicesQuery(userId);
  const devicesRead = useQuery(devicesQuery);
  const phonesRead = useQuery(
    spaceQueries(userId, null).mobileDevices.list.queryOptions({ refetchOnWindowFocus: "always" }),
  );
  const devices = devicesRead.data ?? [];
  const phones = useMobileDeviceRows(phonesRead.data) ?? [];
  const devicesFailed = !devicesRead.data && devicesRead.isError;
  const phonesFailed = !phonesRead.data && phonesRead.isError;
  const currentDevice = plainHttp ? null : thisComputer;
  const listedCurrent = devices.find((device) => device.deviceId === currentDevice?.deviceId);

  // Neither change goes through the RPC client: one is the desktop app's, the other a device route.
  const change = useSave({
    save: async ({ action }: { action: () => Promise<unknown>; failure: string }) => {
      await action();
    },
    stale: [devicesQuery.queryKey, desktopAccess.queryKey],
    // A failed removal or pairing may still have changed something, so both are read again.
    onFailed: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: devicesQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: desktopAccess.queryKey }),
      ]),
  });

  function remove(deviceId: string) {
    change.run({ action: () => removeUserDevice(deviceId), failure: t`Could not remove` });
  }

  if (
    devices.length === 0 &&
    phones.length === 0 &&
    !devicesFailed &&
    !phonesFailed &&
    !currentDevice &&
    !plainHttp
  )
    return null;

  return (
    <SettingsGroup title={<Trans>Your devices</Trans>} data-testid="computer-devices">
      {plainHttp ? (
        <p className="px-4 py-3 text-body-sm text-muted-foreground">
          <Trans>Plain HTTP does not pair this computer. Use HTTPS, or a loopback server.</Trans>
        </p>
      ) : null}
      {currentDevice ? (
        <ComputerRow
          name={listedCurrent?.name ?? currentDevice.name ?? t`This computer`}
          connected={listedCurrent?.connected ?? (currentDevice.local ? true : undefined)}
          bound={listedCurrent?.bound}
          access={{
            allowed: currentDevice.allowed,
            onChange: (allowed) =>
              change.run({
                action: () => currentDevice.setAllowed(allowed),
                failure: t`Could not change`,
              }),
          }}
          pending={change.pending}
          onRemove={listedCurrent ? () => remove(listedCurrent.deviceId) : undefined}
        />
      ) : null}
      {devices
        .filter((device) => device.deviceId !== listedCurrent?.deviceId)
        .map((device) => (
          <ComputerRow
            key={device.deviceId}
            name={device.name}
            connected={device.connected}
            bound={device.bound}
            pending={change.pending}
            onRemove={() => remove(device.deviceId)}
          />
        ))}
      {phones.map((phone) => (
        <SettingsRow
          key={phone.deviceId}
          label={<DeviceIdentity phone name={mobileDeviceName(phone)} />}
          control={
            <>
              <DeviceStatus connected={phone.connected} />
              <span aria-hidden="true" className={DEVICE_ACTION_SLOT} />
            </>
          }
        />
      ))}
      {devicesFailed || phonesFailed ? (
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
              disabled={devicesRead.isFetching || phonesRead.isFetching}
              onClick={() => {
                if (devicesFailed) void devicesRead.refetch();
                if (phonesFailed) void phonesRead.refetch();
              }}
            >
              <Trans>Retry</Trans>
            </Button>
          }
        />
      ) : null}
      {change.error ? (
        <p role="alert" className="px-4 py-3 text-body-sm text-destructive">
          {change.input?.failure}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
