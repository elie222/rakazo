import { Trans } from "@lingui/react/macro";
import { isOllamaCloudBaseUrl } from "@rakazo/contracts";
import { Disclosure } from "@rakazo/ui-web";
import type { ReactNode } from "react";

export function CompatibleKeyField({
  baseUrl,
  className,
  children,
}: {
  baseUrl: string;
  className?: string;
  children: ReactNode;
}) {
  return isOllamaCloudBaseUrl(baseUrl) ? (
    <div className={className}>
      <span>
        <Trans>API key</Trans>
      </span>
      {children}
    </div>
  ) : (
    <Disclosure className={className} summary={<Trans>API key</Trans>}>
      {children}
    </Disclosure>
  );
}
