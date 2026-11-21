import { useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@rakazo/ui-web";
import { MessagesSquare, SquareKanban } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, Suspense, use } from "react";
import { Link, Outlet, useMatch } from "react-router-dom";
import { IconTooltip } from "../../components/IconTooltip";
import { WindowChrome } from "../../components/WindowChrome";
import { desktopBridge } from "../../lib/platform/desktop";

const AppRailContext = createContext(false);

/** True when the rail is on screen from the md breakpoint up and holds the window controls there. */
export function useAppRail() {
  return use(AppRailContext);
}

/** Chats and Board share one frame, so switching between them keeps the rail in place. */
export function AppRailLayout({ enabled }: { enabled: boolean }) {
  if (!enabled) return <Outlet />;
  return (
    <AppRailContext value>
      <div className="flex h-full min-w-0">
        <AppRail />
        <div className="h-full min-w-0 flex-1">
          {/* A page still loading leaves the rail on screen instead of blanking the window. */}
          <Suspense fallback={null}>
            <Outlet />
          </Suspense>
        </div>
      </div>
    </AppRailContext>
  );
}

/** As wide as the macOS window controls, which sit at its top on desktop. */
function AppRail() {
  const { t } = useLingui();
  // Matched like the route itself, so a trailing slash still marks the Board.
  const onBoard = useMatch("/app/board") !== null;
  return (
    <nav
      data-testid="app-rail"
      aria-label={t`Sections`}
      className="app-drag hidden w-18 shrink-0 flex-col items-center gap-2 border-e border-sidebar-border bg-sidebar pt-4 pb-3 md:flex"
    >
      {desktopBridge() ? <WindowChrome className="mb-2" /> : null}
      <RailLink to="/app" label={t`Chats`} active={!onBoard}>
        <MessagesSquare strokeWidth={1.75} />
      </RailLink>
      <RailLink to="/app/board" label={t`Board`} active={onBoard}>
        <SquareKanban strokeWidth={1.75} />
      </RailLink>
    </nav>
  );
}

function RailLink({
  to,
  label,
  active,
  children,
}: {
  to: string;
  label: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <IconTooltip label={label} side="inline-end">
      <Link
        to={to}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={buttonVariants({
          variant: "ghost",
          size: "icon-lg",
          className: `app-no-drag ${active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground"}`,
        })}
      >
        {children}
      </Link>
    </IconTooltip>
  );
}
