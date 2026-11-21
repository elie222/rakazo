import { useLingui } from "@lingui/react/macro";
import { Spinner } from "@rakazo/ui-web";
import type { CSSProperties } from "react";

/**
 * A whole-page wait. The spinner fades in after `delay`, so a quick load paints nothing
 * in between; routes that resolve faster than the delay never flash.
 */
export function PageLoading({
  delay = 500,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & { delay?: number }) {
  const { t } = useLingui();
  return (
    <div className="grid h-full place-items-center bg-background" {...props}>
      <span
        className="page-loading-fade"
        style={{ "--page-loading-delay": `${delay}ms` } as CSSProperties}
      >
        <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
      </span>
    </div>
  );
}
