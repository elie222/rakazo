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
  /** One control for the whole group, at the end of its title. */
  action?: ReactNode;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <section data-testid={testId}>
      {title ? (
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <h3 className="text-body font-medium text-foreground">{title}</h3>
          {action}
        </div>
      ) : null}
      <div className="divide-y divide-border rounded-xl border border-border">{children}</div>
    </section>
  );
}

/**
 * One setting: label then control, side by side when they fit, optional detail below.
 * Every settings surface renders it, so label, control and description keep one rhythm.
 */
export function SettingsRow({
  label,
  description,
  descriptionId,
  htmlFor,
  control,
  children,
}: {
  label: ReactNode;
  /** A line under the label, for the one fact that explains the control. */
  description?: ReactNode;
  /** Lets a control point at the description with `aria-describedby`. */
  descriptionId?: string;
  /** Set when the label names exactly one control. */
  htmlFor?: string;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      data-slot="settings-row"
      className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
    >
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 leading-snug">
        {htmlFor ? (
          <label
            htmlFor={htmlFor}
            data-slot="field-label"
            className="w-full text-body font-normal text-foreground"
          >
            {label}
          </label>
        ) : (
          <div data-slot="field-label" className="w-full text-body font-normal text-foreground">
            {label}
          </div>
        )}
        {description ? (
          <p
            id={descriptionId}
            data-slot="field-description"
            className="text-left text-body-sm text-muted-foreground"
          >
            {description}
          </p>
        ) : null}
      </div>
      {control ? <div className="flex max-w-full min-w-0 items-center gap-2">{control}</div> : null}
      {children ? <div className="w-full">{children}</div> : null}
    </div>
  );
}
