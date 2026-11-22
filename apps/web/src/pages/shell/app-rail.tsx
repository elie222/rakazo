import { useLingui } from "@lingui/react/macro";
import { buttonVariants, cn } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  FolderOpen,
  MessagesSquare,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  SquareKanban,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { createContext, Suspense, use, useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { RouteLoading } from "../../components/RouteLoading";
import { WindowChrome } from "../../components/WindowChrome";
import { authClient } from "../../lib/auth/auth";
import { desktopBridge } from "../../lib/platform/desktop";
import { activityModePreference } from "../../lib/preferences/activity-mode";
import { readAppRailExpanded, writeAppRailExpanded } from "../../lib/preferences/app-rail-pref";
import {
  readBotsSidebarCollapsed,
  writeBotsSidebarCollapsed,
} from "../../lib/preferences/bots-sidebar-pref";
import { useQueryUserId } from "../../lib/query/query";
import { rpc } from "../../lib/query/rpc";
import { useMediaQuery } from "../../lib/use-media-query";
import type { ShellOverlay } from "./shell-overlay-url";
import { withShellOverlay } from "./shell-overlay-url";
import { focusChatList } from "./sidebar/focus-chat-list";
import { ShellSidebarFooter } from "./sidebar/shell-sidebar-footer";

const AppRailContext = createContext(false);
const AppSidebarContext = createContext<{
  listCollapsed: boolean;
  setListCollapsed: (collapsed: boolean) => void;
  previewListCollapsed: (collapsed: boolean) => void;
  railWidth: number;
  railFooterNode: HTMLDivElement | null;
  setRailFooterNode: (node: HTMLDivElement | null) => void;
} | null>(null);

/** True when the rail is on screen from the md breakpoint up and holds the window controls there. */
export function useAppRail() {
  return use(AppRailContext);
}

/** The chat shell owns the overlay host; every other rail page hands the overlay back to it. */
function isChatShellPath(pathname: string, boardEnabled: boolean) {
  return (
    pathname === "/app" ||
    pathname.startsWith("/app/g/") ||
    (pathname.startsWith("/app/") &&
      // Without the lab the Board route is not registered, so `/app/:botId` serves it as a chat.
      !(boardEnabled && pathname.startsWith("/app/board")) &&
      !pathname.startsWith("/app/artifacts") &&
      !pathname.startsWith("/app/x/"))
  );
}

/** The secondary list's collapse state, shared by the rail's restore action and the list. */
export function useAppSidebar() {
  const context = use(AppSidebarContext);
  if (!context) throw new Error("useAppSidebar must be used within AppRailLayout.");
  return context;
}

/** Layout widths a surface can read without requiring the rail; standalone panels see zero. */
export function useAppRailMetrics() {
  const context = use(AppSidebarContext);
  return context
    ? { listCollapsed: context.listCollapsed, railWidth: context.railWidth }
    : { listCollapsed: false, railWidth: 0 };
}

/**
 * The app shell: a primary rail for destinations and the page (which owns the secondary
 * list) beside it. The rail stays in place when the page changes, so Artifacts and Board
 * keep the same navigation as Chats.
 */
export function AppRailLayout({ boardEnabled }: { boardEnabled: boolean }) {
  const userId = useQueryUserId();
  const railVisible = useMediaQuery("(min-width: 48rem)");
  const [preference, setPreference] = useState<boolean | null>(() => readAppRailExpanded(userId));
  const [listCollapsed, setListCollapsedState] = useState(() => readBotsSidebarCollapsed(userId));
  const [railFooterNode, setRailFooterNode] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    setPreference(readAppRailExpanded(userId));
    setListCollapsedState(readBotsSidebarCollapsed(userId));
  }, [userId]);

  // Like the reference, the rail starts as a 56px icon column and widens on request.
  const expanded = preference ?? false;
  const railWidth = railVisible ? (expanded ? 220 : desktopBridge() ? 72 : 56) : 0;
  function toggle() {
    const next = !expanded;
    setPreference(next);
    writeAppRailExpanded(userId, next);
  }
  function setListCollapsed(collapsed: boolean) {
    setListCollapsedState(collapsed);
    writeBotsSidebarCollapsed(userId, collapsed);
  }
  /** A drag previews the collapse without saving it; release commits through `setListCollapsed`. */
  function previewListCollapsed(collapsed: boolean) {
    setListCollapsedState(collapsed);
  }

  return (
    <AppRailContext value>
      <AppSidebarContext
        value={{
          listCollapsed,
          setListCollapsed,
          previewListCollapsed,
          railWidth,
          railFooterNode,
          setRailFooterNode,
        }}
      >
        <div
          className="flex h-full min-h-0"
          style={
            {
              "--app-rail-width": `${railWidth}px`,
            } as CSSProperties
          }
        >
          <PrimaryRail
            boardEnabled={boardEnabled}
            expanded={expanded}
            listCollapsed={listCollapsed}
            onShowChats={() => {
              setListCollapsed(false);
              focusChatList();
            }}
            onToggle={toggle}
            setRailFooterNode={setRailFooterNode}
          />
          <div className="h-full min-h-0 min-w-0 flex-1 md:border-s md:border-sidebar-border">
            {/* A page still loading leaves the rail on screen instead of blanking the window. */}
            <Suspense fallback={<RouteLoading />}>
              <Outlet />
            </Suspense>
          </div>
        </div>
      </AppSidebarContext>
    </AppRailContext>
  );
}

function PrimaryRail({
  boardEnabled,
  expanded,
  listCollapsed,
  onShowChats,
  onToggle,
  setRailFooterNode,
}: {
  boardEnabled: boolean;
  expanded: boolean;
  listCollapsed: boolean;
  onShowChats: () => void;
  onToggle: () => void;
  setRailFooterNode: (node: HTMLDivElement | null) => void;
}) {
  const { t } = useLingui();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const activityMode = activityModePreference.use();
  const integrationsOpen = new URLSearchParams(search).has("integrations");
  const onChatShell = isChatShellPath(pathname, boardEnabled);
  const onChats = !activityMode && onChatShell;
  const onArtifacts = pathname === "/app/artifacts" || pathname.startsWith("/app/artifacts/");
  const onBoard = pathname === "/app/board" || pathname === "/app/board/";
  function openOverlay(overlay: ShellOverlay) {
    const params = withShellOverlay(new URLSearchParams(search), overlay);
    navigate({ pathname: onChatShell ? pathname : "/app", search: params.toString() });
  }

  return (
    <nav
      data-testid="app-rail"
      aria-label={t`Sections`}
      data-expanded={expanded}
      className="app-drag relative z-20 hidden w-(--app-rail-width) shrink-0 flex-col bg-sidebar transition-[width] duration-(--motion-pop) ease-(--ease-out) motion-reduce:transition-none md:flex"
    >
      {desktopBridge() ? <WindowChrome className="mt-3 self-start" /> : null}
      <div
        className={cn(
          "flex h-11 shrink-0 items-center pt-3",
          expanded ? "justify-between gap-2 px-3" : "justify-center px-3",
        )}
      >
        {expanded ? (
          <>
            <RailBrand />
            <RailToggle expanded label={t`Collapse sidebar`} onClick={onToggle} />
          </>
        ) : (
          <button
            type="button"
            aria-label={t`Expand sidebar`}
            aria-expanded={false}
            onClick={onToggle}
            className="app-no-drag group/rail-toggle relative grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <RailBrandMark className="transition-[opacity,scale] duration-(--motion-floating) ease-(--ease-out) group-hover/rail-toggle:scale-75 group-hover/rail-toggle:opacity-0 group-focus-visible/rail-toggle:scale-75 group-focus-visible/rail-toggle:opacity-0 motion-reduce:transition-none" />
            <PanelLeftOpen
              className="absolute size-5 scale-75 opacity-0 transition-[opacity,scale] duration-(--motion-floating) ease-(--ease-out) group-hover/rail-toggle:scale-100 group-hover/rail-toggle:opacity-100 group-focus-visible/rail-toggle:scale-100 group-focus-visible/rail-toggle:opacity-100 motion-reduce:transition-none"
              strokeWidth={1.75}
              aria-hidden="true"
            />
          </button>
        )}
      </div>

      <div className="mt-7 flex flex-col gap-2 px-3">
        {listCollapsed ? (
          <RailItem
            active={false}
            expanded={expanded}
            icon={<PanelLeft className="size-5" strokeWidth={1.75} aria-hidden="true" />}
            label={t`Show chat list`}
            testId="show-chat-list"
            onClick={() => {
              // Board and Artifacts have no chat list beside them; bring the shell back first.
              if (!onChatShell) navigate("/app");
              onShowChats();
            }}
          />
        ) : null}
        <RailItem
          active={onChats}
          expanded={expanded}
          icon={<MessagesSquare className="size-5" strokeWidth={1.75} aria-hidden="true" />}
          label={t`Chats`}
          to="/app"
          onClick={() => {
            activityModePreference.set(false);
            if (listCollapsed) onShowChats();
          }}
        />
        <RailItem
          active={activityMode && onChatShell}
          expanded={expanded}
          toggles
          icon={<Bell className="size-5" strokeWidth={1.75} aria-hidden="true" />}
          label={t`Activity`}
          onClick={() => {
            // The list is hidden, so the active item only needs to bring it back, not toggle off.
            if (listCollapsed) {
              activityModePreference.set(true);
              if (!onChatShell) navigate("/app");
              onShowChats();
              return;
            }
            // From another page the first press opens Activity there; on the chat shell it toggles.
            activityModePreference.set(onChatShell ? !activityMode : true);
            if (!onChatShell) navigate("/app");
          }}
        />
        <RailItem
          active={onArtifacts}
          expanded={expanded}
          icon={<FolderOpen className="size-5" strokeWidth={1.75} aria-hidden="true" />}
          label={t`Artifacts`}
          to="/app/artifacts"
          onClick={() => activityModePreference.set(false)}
        />
        {boardEnabled ? (
          <RailItem
            active={onBoard}
            expanded={expanded}
            icon={<SquareKanban className="size-5" strokeWidth={1.75} aria-hidden="true" />}
            label={t`Board`}
            to="/app/board"
            onClick={() => activityModePreference.set(false)}
          />
        ) : null}
        <RailItem
          active={integrationsOpen}
          expanded={expanded}
          icon={<Plug className="size-5" strokeWidth={1.75} aria-hidden="true" />}
          label={t`Connect apps`}
          onClick={() => openOverlay({ kind: "integrations" })}
        />
      </div>
      <div
        ref={setRailFooterNode}
        data-testid="app-rail-footer"
        className={cn(
          "app-no-drag mt-auto flex w-full flex-col px-3 py-3",
          expanded ? "items-start" : "items-center",
        )}
      >
        {onChatShell ? null : <RailFooter boardEnabled={boardEnabled} openOverlay={openOverlay} />}
      </div>
    </nav>
  );
}

/** The account entry stays in the layout, so every page beside the rail keeps it. */
function RailFooter({
  boardEnabled,
  openOverlay,
}: {
  boardEnabled: boolean;
  openOverlay: (overlay: ShellOverlay) => void;
}) {
  const { data } = authClient.useSession();
  const navigate = useNavigate();
  // The desktop renderer is not served from the deployment's origin, so custom pages are web-only.
  const desktop = Boolean(desktopBridge());
  const me = useQuery({
    queryKey: ["me", "nav-links"],
    queryFn: () => rpc.me(),
    enabled: !desktop,
  });
  return (
    <ShellSidebarFooter
      mini
      logos={[]}
      user={data?.user}
      boardEnabled={boardEnabled}
      navLinks={desktop ? [] : (me.data?.navLinks ?? [])}
      closeMobileSidebar={() => undefined}
      navigate={navigate}
      openSettings={(section) => openOverlay({ kind: "settings", section, spaceId: null })}
      openIntegrations={() => openOverlay({ kind: "integrations" })}
      openSkills={() => openOverlay({ kind: "skills" })}
    />
  );
}

function RailBrand() {
  return (
    <span className="flex h-8 min-w-0 flex-1 items-center gap-2" aria-hidden="true">
      <RailBrandMark />
      <span className="min-w-0 flex-1 truncate text-center text-body font-medium">Rakazo</span>
    </span>
  );
}

function RailBrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center gap-1 rounded-full bg-card",
        className,
      )}
    >
      <span className="h-3 w-[5px] rounded-full bg-primary" />
      <span className="h-3 w-[5px] rounded-full bg-primary" />
    </span>
  );
}

function RailToggle({
  expanded,
  label,
  onClick,
}: {
  expanded: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      onClick={onClick}
      className={buttonVariants({
        variant: "ghost",
        size: "icon",
        className: "app-no-drag shrink-0 rounded-full text-muted-foreground",
      })}
    >
      {expanded ? (
        <PanelLeftClose className="size-5" strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <PanelLeftOpen className="size-5" strokeWidth={1.75} aria-hidden="true" />
      )}
    </button>
  );
}

function RailItem({
  active,
  expanded,
  toggles = false,
  icon,
  label,
  to,
  onClick,
  testId,
}: {
  active: boolean;
  expanded: boolean;
  /** Only a control that switches a mode reports a pressed state to assistive technology. */
  toggles?: boolean;
  icon: ReactNode;
  label: string;
  to?: string;
  onClick?: () => void;
  testId?: string;
}) {
  const className = buttonVariants({
    variant: "ghost",
    size: "icon",
    className: cn(
      "app-no-drag group/rail-item relative min-w-0 shrink-0 select-none justify-start overflow-hidden rounded-full border-0 px-0 text-start",
      expanded
        ? "w-full gap-2"
        : "hover:w-max hover:bg-primary hover:pe-2.5 hover:text-primary-foreground hover:shadow-md focus-visible:w-max focus-visible:bg-primary focus-visible:pe-2.5 focus-visible:text-primary-foreground focus-visible:shadow-md",
      active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground",
      expanded && !active && "hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
    ),
  });
  const content = (
    <>
      <span className="ms-1.5 flex size-5 shrink-0 items-center justify-center">{icon}</span>
      {expanded ? (
        <span className="min-w-0 truncate text-body">{label}</span>
      ) : (
        <span className="pointer-events-none absolute start-[34px] top-1/2 -translate-y-1/2 whitespace-nowrap text-label opacity-0 transition-opacity duration-(--motion-micro) ease-(--ease-standard) group-hover/rail-item:static group-hover/rail-item:translate-y-0 group-hover/rail-item:opacity-100 group-focus-visible/rail-item:static group-focus-visible/rail-item:translate-y-0 group-focus-visible/rail-item:opacity-100 motion-reduce:transition-none">
          {label}
        </span>
      )}
    </>
  );
  const control = to ? (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      data-testid={testId}
      className={className}
      onClick={onClick}
    >
      {content}
    </Link>
  ) : (
    <button
      type="button"
      aria-pressed={toggles ? active : undefined}
      aria-label={label}
      data-testid={testId}
      className={className}
      onClick={onClick}
    >
      {content}
    </button>
  );
  return control;
}
