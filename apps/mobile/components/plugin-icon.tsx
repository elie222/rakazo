import { useEffect, useState } from "react";
import { loadLinkFavicon } from "../lib/link-favicons";
import { ConnectorIcon } from "./connector-icon";

const favicons = new Map<string, Promise<string | null>>();

function siteIcon(site: string): Promise<string | null> {
  let icon = favicons.get(site);
  if (!icon) {
    icon = loadLinkFavicon(site)
      .then((answer) => answer.icon)
      .catch(() => {
        favicons.delete(site);
        return null;
      });
    favicons.set(site, icon);
  }
  return icon;
}

/** A plugin's own artwork, else its site's icon from our API, else its initial. */
export function PluginIcon({
  name,
  logo,
  site,
  size,
}: {
  name: string;
  logo?: string | null;
  site?: string | null;
  size?: number;
}) {
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    setIcon(null);
    if (logo || !site) return;
    let cancelled = false;
    void siteIcon(site).then((found) => {
      if (!cancelled) setIcon(found);
    });
    return () => {
      cancelled = true;
    };
  }, [logo, site]);
  return <ConnectorIcon logo={logo || icon} name={name} size={size} />;
}
