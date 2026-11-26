import { Trans, useLingui } from "@lingui/react/macro";
import type { AppIcon } from "@rakazo/contracts";
import { APP_ICONS, isAppIcon } from "@rakazo/contracts";
import { appIconLabel } from "@rakazo/i18n/app-icon";
import { ToggleGroup, ToggleGroupItem } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { SettingsRow } from "../../components/settings/SettingsRows";
import type { RakazoDesktop } from "../../lib/platform/desktop";
import { desktopBridge } from "../../lib/platform/desktop";
import { useSave } from "../../lib/query/query";

/** The icon belongs to this computer, not to the signed-in user. */
const APP_ICON_KEY = ["desktop", "appIcon"] as const;

/** Only the desktop app can change its own Dock or taskbar icon. */
export function AppIconPicker() {
  const bridge = desktopBridge()?.appIcon;
  return bridge ? <DesktopAppIconPicker bridge={bridge} /> : null;
}

function DesktopAppIconPicker({ bridge }: { bridge: NonNullable<RakazoDesktop["appIcon"]> }) {
  const { t } = useLingui();
  const labelId = useId();
  const queryClient = useQueryClient();
  const { data: saved } = useQuery({ queryKey: APP_ICON_KEY, queryFn: () => bridge.get() });
  const change = useSave({
    save: async (icon: AppIcon) => {
      if (!(await bridge.set(icon))) throw new Error("The desktop app kept its icon.");
    },
    onSaved: (_done, icon) => queryClient.setQueryData(APP_ICON_KEY, icon),
  });
  const shown = change.pending ? change.input : saved;

  return (
    <SettingsRow
      label={
        <span id={labelId}>
          <Trans>App icon</Trans>
        </span>
      }
      control={
        <div className="space-y-1">
          <ToggleGroup
            aria-labelledby={labelId}
            data-testid="app-icon-select"
            disabled={saved === undefined || change.pending}
            value={shown ? [shown] : []}
            onValueChange={([next]) => {
              if (isAppIcon(next) && next !== saved) change.run(next);
            }}
            spacing={1}
            className="grid grid-cols-6"
          >
            {APP_ICONS.map((option) => (
              <ToggleGroupItem
                key={option}
                value={option}
                aria-label={appIconLabel(option)}
                className="h-auto rounded-xl p-0.5 aria-pressed:bg-transparent aria-pressed:ring-2 aria-pressed:ring-primary"
              >
                <img
                  src={`/app-icons/${option}.webp`}
                  alt=""
                  width={40}
                  height={40}
                  className="rounded-[22%]"
                />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {change.error ? (
            <p role="alert" className="text-body-sm text-destructive">
              {t`Couldn't change the app icon`}
            </p>
          ) : null}
        </div>
      }
    />
  );
}
