import type { ComponentProps } from "react";

export const settingsSectionHeadingClass = "text-heading3 font-medium text-foreground";

export function SettingsSectionHeading({ className = "mb-3", ...props }: ComponentProps<"h3">) {
  return <h3 className={`${settingsSectionHeadingClass} ${className}`} {...props} />;
}
