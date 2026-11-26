import { Trans, useLingui } from "@lingui/react/macro";
import type { AppIcon } from "@rakazo/contracts";
import { APP_ICONS, DEFAULT_APP_ICON, isAppIcon } from "@rakazo/contracts";
import { appIconLabel } from "@rakazo/i18n/app-icon";
import { ToggleGroup, ToggleGroupItem } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { SettingsRow } from "../../components/settings/SettingsRows";
import { desktopBridge } from "../../lib/platform/desktop";

/** Only the desktop app can change its own Dock or taskbar icon. */
export function AppIconPicker() {
  const bridge = desktopBridge()?.appIcon;
  return bridge ? <DesktopAppIconPicker bridge={bridge} /> : null;
}

function DesktopAppIconPicker({
  bridge,
}: {
  bridge: NonNullable<NonNullable<ReturnType<typeof desktopBridge>>["appIcon"]>;
}) {
  const { t } = useLingui();
  const labelId = useId();
  const [icon, setIcon] = useState<AppIcon | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    bridge.get().then(
      (current) => {
        if (active) setIcon(current);
      },
      () => {
        if (active) setIcon(DEFAULT_APP_ICON);
      },
    );
    return () => {
      active = false;
    };
  }, [bridge]);

  function choose(next: AppIcon) {
    const previous = icon;
    setIcon(next);
    setFailed(false);
    bridge.set(next).then(
      (saved) => {
        if (saved) return;
        setIcon(previous);
        setFailed(true);
      },
      () => {
        setIcon(previous);
        setFailed(true);
      },
    );
  }

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
            value={icon ? [icon] : []}
            onValueChange={([next]) => {
              if (isAppIcon(next) && next !== icon) choose(next);
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
          {failed ? (
            <p role="alert" className="text-body-sm text-destructive">
              {t`Couldn't change the app icon`}
            </p>
          ) : null}
        </div>
      }
    />
  );
}
