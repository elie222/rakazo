import { i18n } from "@lingui/core";
import type { ReactNode } from "react";

export function MessageHoverMetadata({
  createdAt,
  children,
}: {
  createdAt: string;
  children: ReactNode;
}) {
  return (
    <div className="pointer-events-none absolute end-0 top-0 z-10 flex items-center gap-1.5 opacity-0 transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
      <time dateTime={createdAt} className="text-[11px] tabular-nums text-muted-foreground">
        {new Date(createdAt).toLocaleTimeString(i18n.locale || "en", {
          hour: "numeric",
          minute: "2-digit",
        })}
      </time>
      {children}
    </div>
  );
}
