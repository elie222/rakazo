import { Trans } from "@lingui/react/macro";
import { Disclosure } from "@rakazo/ui-web";
import type { ReactNode } from "react";

export function CompatibleKeyField({
  required,
  className,
  children,
}: {
  /** The endpoint is a hosted preset that refuses requests without a key. */
  required: boolean;
  className?: string;
  children: ReactNode;
}) {
  return required ? (
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
