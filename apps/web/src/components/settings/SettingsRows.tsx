import { Field, FieldDescription, FieldLabel, FieldTitle } from "@rakazo/ui-web";
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
 * Built on the shared field primitives, so every settings surface keeps the same rhythm.
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
    <Field
      data-slot="settings-row"
      orientation="horizontal"
      className="flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
    >
      {/* A plain block, not FieldContent: the horizontal field pins a content child to the top,
          which leaves the label high beside a taller select or button. */}
      <div className="flex min-h-9 min-w-0 flex-auto flex-col justify-center gap-0.5 leading-snug">
        {htmlFor ? (
          <FieldLabel htmlFor={htmlFor} className="w-full text-body font-normal text-foreground">
            {label}
          </FieldLabel>
        ) : (
          <FieldTitle className="w-full flex-col items-stretch text-body font-normal text-foreground">
            {label}
          </FieldTitle>
        )}
        {description ? (
          <FieldDescription id={descriptionId} className="text-start text-body-sm">
            {description}
          </FieldDescription>
        ) : null}
      </div>
      {control ? <div className="flex max-w-full min-w-0 items-center gap-2">{control}</div> : null}
      {children ? <div className="w-full">{children}</div> : null}
    </Field>
  );
}
