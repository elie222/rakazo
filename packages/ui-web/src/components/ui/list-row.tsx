import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@rakazo/ui-web/lib/utils";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { createContext, useContext } from "react";

const ListRowCurrentContext = createContext(false);

/**
 * A navigation row with a stable 56px rhythm. The row itself is a plain wrapper so the
 * link and its actions stay siblings; an action must never sit inside the link.
 */
function ListRow({
  active = false,
  current = active,
  tone = "sidebar",
  actions,
  fade = "32px",
  className,
  style,
  children,
  ...props
}: ComponentProps<"div"> & {
  active?: boolean;
  /** Whether this row is the page the reader is on; a drop target is active but not current. */
  current?: boolean;
  /** The surface the row sits on: the sidebar, or a page body. */
  tone?: "sidebar" | "surface";
  actions?: ReactNode;
  /** How much of the row's end fades under the revealed actions. */
  fade?: string;
}) {
  return (
    <ListRowCurrentContext value={current}>
      <div
        data-slot="list-row"
        data-active={active || undefined}
        className={cn(
          "group/list-row relative rounded-lg transition-colors duration-(--motion-micro) ease-(--ease-standard)",
          active
            ? tone === "sidebar"
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "bg-accent text-accent-foreground"
            : tone === "sidebar"
              ? "hover:bg-sidebar-accent/60 focus-within:bg-sidebar-accent/60"
              : "hover:bg-accent focus-within:bg-accent",
          className,
        )}
        style={
          {
            ...style,
            "--row-reveal-fade": fade,
          } as CSSProperties
        }
        {...props}
      >
        {children}
        {actions}
      </div>
    </ListRowCurrentContext>
  );
}

/**
 * The row's clickable area. Pass `render={<Link to=… />}` to keep routing; the merged
 * classes and data attributes are what make it a list row.
 */
function ListRowLink({
  className,
  render,
  "aria-current": ariaCurrent,
  ...props
}: useRender.ComponentProps<"a"> & ComponentProps<"a">) {
  const current = useContext(ListRowCurrentContext);
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        "aria-current": ariaCurrent ?? (current ? "page" : undefined),
        className: cn(
          "relative flex min-h-14 w-full min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-start text-inherit outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring/50",
          className,
        ),
      },
      props,
    ),
    render,
    state: { slot: "list-row-link" },
  });
}

function ListRowAvatar({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="list-row-avatar"
      className={cn("flex size-9 shrink-0 items-center justify-center", className)}
      {...props}
    />
  );
}

function ListRowContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="list-row-content" className={cn("min-w-0 flex-1", className)} {...props} />
  );
}

function ListRowTitle({
  unread = false,
  className,
  ...props
}: ComponentProps<"span"> & { unread?: boolean }) {
  return (
    <span
      data-slot="list-row-title"
      data-unread={unread || undefined}
      className={cn(
        "block truncate text-body",
        unread ? "font-semibold" : "font-medium",
        className,
      )}
      {...props}
    />
  );
}

function ListRowDescription({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="list-row-description"
      className={cn("mt-0.5 block truncate text-label text-muted-foreground", className)}
      {...props}
    />
  );
}

function ListRowStatus({
  working = false,
  failed = false,
  unread = false,
  label,
  className,
  ...props
}: ComponentProps<"span"> & {
  working?: boolean;
  failed?: boolean;
  unread?: boolean;
  /** Localized text for the dots, so the row does not rely on color alone. */
  label?: string;
}) {
  if (!working && !failed && !unread) return null;
  return (
    <span
      data-slot="list-row-status"
      className={cn("ms-auto flex shrink-0 items-center gap-1 self-start pt-1.5", className)}
      {...props}
    >
      {label ? <span className="sr-only">{label}</span> : null}
      {failed ? (
        <span className="size-2 rounded-full bg-destructive" aria-hidden="true" />
      ) : working ? (
        <span className="size-2 rounded-full bg-status-working" aria-hidden="true" />
      ) : null}
      {unread ? <span className="size-2 rounded-full bg-unread" aria-hidden="true" /> : null}
    </span>
  );
}

/**
 * The actions revealed at the row's end. It is a sibling of the link, so a click here
 * can never navigate; the row fades its title underneath it instead of cutting it.
 */
function RowActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="row-actions"
      className={cn(
        "row-reveal-action absolute end-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5",
        className,
      )}
      {...props}
    />
  );
}

export {
  ListRow,
  ListRowAvatar,
  ListRowContent,
  ListRowDescription,
  ListRowLink,
  ListRowStatus,
  ListRowTitle,
  RowActions,
};
