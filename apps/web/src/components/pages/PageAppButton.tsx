import { Trans, useLingui } from "@lingui/react/macro";
import type { PageAbility, PageIconColor } from "@rakazo/contracts";
import { pageWebAppUrl } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  Button,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { AppWindow, MonitorDown } from "lucide-react";
import { useState } from "react";
import { pageAppIconPngs, pageAppIconSvg, svgDataUrl } from "../../lib/pages/page-app-icon";
import { desktopBridge } from "../../lib/platform/desktop";
import { useSave } from "../../lib/query/query";
import { selectedSpaceId } from "../../lib/query/rpc";
import { useBoundSpaceId } from "../../lib/query/space-rpc";
import { isStandalone } from "../../pwa/standalone";

const INSTALLED_KEY = ["desktop", "page-apps"] as const;

type InstallablePage = {
  id: string;
  title: string;
  icon: string | null;
  iconColor: PageIconColor | null;
  abilities: PageAbility[];
};

/**
 * Installs the page as its own app where the desktop can, or opens the app already installed. A
 * browser installs it from the page opened on its own, which this opens in a new window. Rakazo
 * installed as an app keeps that window as one of its own, where the browser offers no install.
 */
export function PageAppButton({ page, className }: { page: InstallablePage; className?: string }) {
  if (desktopBridge()) return <DesktopPageAppButton page={page} className={className} />;
  return isStandalone() ? null : <BrowserPageAppButton pageId={page.id} className={className} />;
}

function BrowserPageAppButton({ pageId, className }: { pageId: string; className?: string }) {
  const { t } = useLingui();
  const boundSpaceId = useBoundSpaceId();
  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      aria-label={t`Install app`}
      onClick={() => {
        const spaceId = boundSpaceId === undefined ? selectedSpaceId() : boundSpaceId;
        window.open(pageWebAppUrl(pageId, spaceId), "_blank", "noopener");
      }}
    >
      <MonitorDown strokeWidth={1.5} />
    </Button>
  );
}

function DesktopPageAppButton({ page, className }: { page: InstallablePage; className?: string }) {
  const { t } = useLingui();
  const bridge = desktopBridge()?.pageApps;
  const [confirming, setConfirming] = useState(false);
  const installed = useQuery({
    queryKey: INSTALLED_KEY,
    queryFn: () => bridge!.installed(),
    enabled: Boolean(bridge),
  });
  const icon = useQuery({
    queryKey: ["page-app-icon", page.id, page.icon, page.iconColor],
    queryFn: () => pageAppIconSvg(page),
    enabled: confirming,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const install = useSave({
    save: async (_, rpc) => {
      if (!bridge) throw new Error("This app cannot install pages.");
      const pngs = await pageAppIconPngs(icon.data ?? (await pageAppIconSvg(page)));
      const app = await rpc.pageApps.install({ pageId: page.id, abilities: page.abilities });
      const made = await bridge.install({
        appId: app.appId,
        token: app.token,
        pageId: page.id,
        title: app.title,
        abilities: page.abilities,
        icon: pngs,
      });
      if (!made) throw new Error("The app could not be made.");
    },
    stale: [INSTALLED_KEY],
    onSaved: () => setConfirming(false),
  });
  if (!bridge) return null;
  const app = installed.data?.find((each) => each.pageId === page.id);
  if (app)
    return (
      <Button
        variant="ghost"
        size="icon"
        className={className}
        aria-label={t`Open app`}
        onClick={() => void bridge.open(app.appId)}
      >
        <AppWindow strokeWidth={1.5} />
      </Button>
    );
  const abilityLabels: Record<PageAbility, string> = {
    ask: t`Ask the bot questions`,
    notify: t`Show notifications`,
  };
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={className}
        aria-label={t`Install app`}
        onClick={() => setConfirming(true)}
      >
        <MonitorDown strokeWidth={1.5} />
      </Button>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => !install.pending && setConfirming(open)}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia className="size-16 bg-transparent">
              {icon.data ? <img alt="" src={svgDataUrl(icon.data)} className="size-16" /> : null}
            </AlertDialogMedia>
            <AlertDialogTitle>
              <Trans>Install {page.title}?</Trans>
            </AlertDialogTitle>
            {page.abilities.length ? (
              <AlertDialogDescription render={<div />}>
                <p>
                  <Trans>It can:</Trans>
                </p>
                <ul className="mt-1 list-disc pl-5 text-left">
                  {page.abilities.map((ability) => (
                    <li key={ability}>{abilityLabels[ability]}</li>
                  ))}
                </ul>
              </AlertDialogDescription>
            ) : null}
            {install.error ? (
              <p role="alert" className="text-label text-destructive">
                <Trans>Couldn't install this app. Try again.</Trans>
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={install.pending}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <Button disabled={install.pending} onClick={() => install.run()}>
              <Trans>Install</Trans>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
