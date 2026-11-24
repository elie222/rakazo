import { Trans, useLingui } from "@lingui/react/macro";
import { ANDROID_APP_STORE_URL, IOS_APP_STORE_URL } from "@rakazo/contracts";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@rakazo/ui-web";
import { ChevronDown, Laptop, Smartphone } from "lucide-react";
import { SettingsGroup } from "../settings/SettingsRows";

export function ConnectDevicesSettings() {
  const { t } = useLingui();
  const devices = [
    {
      title: t`Connect your Mac`,
      icon: Laptop,
      url: "https://rakazo.com/download/",
    },
    {
      title: t`Connect your Android phone`,
      icon: Smartphone,
      url: ANDROID_APP_STORE_URL,
    },
    {
      title: t`Connect your iPhone`,
      icon: Smartphone,
      url: IOS_APP_STORE_URL,
    },
  ];
  return (
    <SettingsGroup title={<Trans>Connect more devices</Trans>}>
      {devices.map(({ title, icon: Icon, url }) => (
        <Collapsible key={url}>
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="lg"
                className="group/connect w-full justify-between px-4"
              />
            }
          >
            <span className="flex min-w-0 items-center gap-2 text-pretty text-start">
              <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
              {title}
            </span>
            <ChevronDown
              aria-hidden="true"
              className="text-muted-foreground group-aria-expanded/connect:rotate-180"
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-1 px-4 pb-3 ps-10 text-body-sm text-muted-foreground">
              <p>
                <Trans>
                  Open Rakazo on that device and sign in to the same account and server.
                </Trans>
              </p>
              <a href={url} target="_blank" rel="noreferrer" className="text-link hover:underline">
                <Trans>Download Rakazo</Trans>
              </a>
            </div>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </SettingsGroup>
  );
}
