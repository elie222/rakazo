import { useLingui } from "@lingui/react/macro";
import { Button, cn } from "@rakazo/ui-web";
import {
  Bell,
  FolderOpen,
  MessagesSquare,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  SquareKanban,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { createContext, Suspense, use, useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { IconTooltip } from "../../components/IconTooltip";
import { WindowChrome } from "../../components/WindowChrome";
import { desktopBridge } from "../../lib/platform/desktop";
import { activityModePreference } from "../../lib/preferences/activity-mode";
import { readAppRailExpanded, writeAppRailExpanded } from "../../lib/preferences/app-rail-pref";
import {
  readBotsSidebarCollapsed,
  writeBotsSidebarCollapsed,
} from "../../lib/preferences/bots-sidebar-pref";
import { useQueryUserId } from "../../lib/query/query";
import { useMediaQuery } from "../../lib/use-media-query";

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

/** The secondary list's collapse state, shared by the rail's restore action and the list. */
export function useAppSidebar() {
  const context = use(AppSidebarContext);
  if (!context) throw new Error("useAppSidebar must be used within AppRailLayout.");
  return context;
}

/**
 * The app shell: a primary rail for destinations and the page (which owns the secondary
 * list) beside it. The rail stays in place when the page changes, so Artifacts and Board
 * keep the same navigation as Chats.
 */
export function AppRailLayout({ boardEnabled }: { boardEnabled: boolean }) {
  const userId = useQueryUserId();
  const wide = useMediaQuery("(min-width: 64rem)");
  const railVisible = useMediaQuery("(min-width: 48rem)");
  const [preference, setPreference] = useState<boolean | null>(() => readAppRailExpanded(userId));
  const [listCollapsed, setListCollapsedState] = useState(() => readBotsSidebarCollapsed(userId));
  const [railFooterNode, setRailFooterNode] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    setPreference(readAppRailExpanded(userId));
    setListCollapsedState(readBotsSidebarCollapsed(userId));
  }, [userId]);

  const expanded = preference ?? wide;
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
            onShowChats={() => setListCollapsed(false)}
            onToggle={toggle}
            setRailFooterNode={setRailFooterNode}
          />
          <div className="h-full min-h-0 min-w-0 flex-1">
            {/* A page still loading leaves the rail on screen instead of blanking the window. */}
            <Suspense fallback={null}>
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
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const activityMode = activityModePreference.use();
  const onChatShell =
    pathname === "/app" ||
    pathname.startsWith("/app/g/") ||
    (pathname.startsWith("/app/") &&
      !pathname.startsWith("/app/board") &&
      !pathname.startsWith("/app/artifacts") &&
      !pathname.startsWith("/app/x/"));
  const onChats = !activityMode && onChatShell;
  const onArtifacts = pathname === "/app/artifacts" || pathname.startsWith("/app/artifacts/");
  const onBoard = pathname === "/app/board" || pathname === "/app/board/";

  return (
    <nav
      data-testid="app-rail"
      aria-label={t`Sections`}
      className="app-drag relative z-20 hidden w-(--app-rail-width) shrink-0 flex-col border-e border-sidebar-border bg-sidebar pb-3 transition-[width] duration-(--motion-layout) ease-(--ease-standard) motion-reduce:transition-none md:flex"
    >
      <div className={cn("flex shrink-0 flex-col gap-2 pt-4", expanded ? "px-4" : "items-center")}>
        {desktopBridge() ? <WindowChrome className="self-start" /> : null}
        <div className={cn("flex items-center gap-2", expanded ? "w-full" : "justify-center")}>
          {expanded ? <RailBrand /> : null}
          <IconTooltip label={expanded ? t`Collapse sidebar` : t`Expand sidebar`} side="inline-end">
            <Button
              variant="ghost"
              size="icon"
              aria-label={expanded ? t`Collapse sidebar` : t`Expand sidebar`}
              aria-expanded={expanded}
              onClick={onToggle}
              className="app-no-drag shrink-0 text-muted-foreground"
            >
              {expanded ? (
                <PanelLeftClose className="size-5" strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <PanelLeftOpen className="size-5" strokeWidth={1.75} aria-hidden="true" />
              )}
            </Button>
          </IconTooltip>
        </div>
      </div>

      <div className={cn("mt-4 flex flex-col gap-1", expanded ? "px-3" : "items-center px-2")}>
        {listCollapsed ? (
          <RailItem
            active={false}
            expanded={expanded}
            icon={<PanelLeft className="size-5" strokeWidth={1.75} aria-hidden="true" />}
            label={t`Show chat list`}
            testId="show-chat-list"
            onClick={onShowChats}
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
          icon={<Bell className="size-5" strokeWidth={1.75} aria-hidden="true" />}
          label={t`Activity`}
          onClick={() => {
            // From another page the first press opens Activity there; on the chat shell it toggles.
            activityModePreference.set(onChatShell ? !activityMode : true);
            if (!onChatShell) navigate("/app");
            if (listCollapsed) onShowChats();
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
      </div>
      <div
        ref={setRailFooterNode}
        data-testid="app-rail-footer"
        className="app-no-drag mt-auto flex w-full justify-center px-2 pb-1"
      />
    </nav>
  );
}

function RailBrand() {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2" aria-hidden="true">
      <span className="flex size-7 items-center justify-center gap-1 rounded-full bg-card">
        <span className="h-3 w-[5px] rounded-full bg-primary" />
        <span className="h-3 w-[5px] rounded-full bg-primary" />
      </span>
      <span className="truncate text-body-lg font-medium">Rakazo</span>
    </span>
  );
}

function RailItem({
  active,
  expanded,
  icon,
  label,
  to,
  onClick,
  testId,
}: {
  active: boolean;
  expanded: boolean;
  icon: ReactNode;
  label: string;
  to?: string;
  onClick?: () => void;
  testId?: string;
}) {
  const className = cn(
    "app-no-drag flex h-10 min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-start outline-none transition-[color,background-color,transform] duration-(--motion-micro) ease-(--ease-standard) focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:active:scale-100",
    expanded ? "w-full" : "w-10 justify-center",
    active
      ? "bg-sidebar-accent text-sidebar-accent-foreground"
      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
  );
  const content = (
    <>
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      {expanded ? <span className="min-w-0 truncate text-body">{label}</span> : null}
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
      aria-pressed={active}
      aria-label={label}
      data-testid={testId}
      className={className}
      onClick={onClick}
    >
      {content}
    </button>
  );
  return expanded ? (
    control
  ) : (
    <IconTooltip label={label} side="inline-end">
      {control}
    </IconTooltip>
  );
}
