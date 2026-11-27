import type { ReactNode } from "react";

export const SETTINGS_CONTENT_WIDTH = "max-w-2xl";

/** A titled list of settings rows sharing one bordered surface. */
export function SettingsGroup({
  title,
  action,
  children,
  "data-testid": testId,
}: {
  title?: ReactNode;
  /** One control for the whole group, at the end of its title row (shown even without a title). */
  action?: ReactNode;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <section data-testid={testId}>
      {title || action ? (
        // Inset by the group's border and row padding, so the title starts where row text does.
        <div className="mx-px mb-2 flex items-center justify-end gap-3 px-4">
          {title ? (
            <h3 className="me-auto text-body font-medium text-foreground">{title}</h3>
          ) : null}
          {action}
        </div>
      ) : null}
      <div className="divide-y divide-border rounded-xl border border-border">{children}</div>
    </section>
  );
}

/** One setting: label then control, side by side when they fit, optional detail below. */
export function SettingsRow({
  label,
  control,
  children,
}: {
  label: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 text-body text-foreground">{label}</div>
        {control ? (
          <div className="flex max-w-full min-w-0 items-center gap-2">{control}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
