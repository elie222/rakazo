import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { Bell, PanelLeftClose, PanelLeftOpen, Plus, Search } from "lucide-react";
import { IconTooltip } from "../../../components/IconTooltip";
import { WindowChrome } from "../../../components/WindowChrome";
import { desktopBridge } from "../../../lib/platform/desktop";
import { useAppRail } from "../app-rail";
import { BotCreatePicker } from "../bots/bot-picker";
import type { Panel } from "../right-panel-state";

// A size class, since the Button sizes any svg without one to 16px.
const ICON = "size-4.5";
const TOGGLE_ICON = `${ICON} rtl:rotate-180`;
const STROKE = 1.75;

export function SidebarHeader({
  mini = false,
  createMenuOpen,
  setCreateMenuOpen,
  activityMode,
  toggleActivityMode,
  searchOpen = false,
  onSearch,
  setBotsSidebarCollapsedPref,
  bots,
  setMobileSidebarOpen,
  setPanel,
  navigate,
  setNewSpaceOpen,
  setCreateBotOpen,
}: {
  mini?: boolean;
  createMenuOpen: boolean;
  setCreateMenuOpen: (open: boolean) => void;
  activityMode: boolean;
  toggleActivityMode: () => void;
  searchOpen?: boolean;
  onSearch?: () => void;
  setBotsSidebarCollapsedPref: (collapsed: boolean) => void;
  bots: Bot[];
  setMobileSidebarOpen: (open: boolean) => void;
  setPanel: (panel: Panel) => void;
  navigate: (path: string) => void;
  setNewSpaceOpen: (open: boolean) => void;
  setCreateBotOpen: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const hasWindowChrome = Boolean(desktopBridge());
  // The rail holds the window controls from md up; the phone drawer still needs them.
  const rail = useAppRail();
  const toggleLabel = mini ? t`Show bots` : t`Minimize bots`;
  // In the icon rail the actions stack, so a label above or below covers its neighbour.
  const labelSide = mini ? "inline-end" : undefined;
  // In the rail the buttons share the bot tiles' box, so hover shapes line up.
  const railTile = mini ? "size-12 rounded-xl" : "";
  const toggle = (
    <IconTooltip label={toggleLabel} side={labelSide}>
      <Button
        variant="ghost"
        size="icon"
        className={`app-no-drag hidden text-muted-foreground md:inline-flex ${railTile}`}
        aria-label={toggleLabel}
        data-testid={mini ? "restore-bots-sidebar" : "minimize-bots-sidebar"}
        onClick={() => setBotsSidebarCollapsedPref(!mini)}
      >
        {mini ? (
          <PanelLeftOpen className={TOGGLE_ICON} strokeWidth={STROKE} aria-hidden="true" />
        ) : (
          <PanelLeftClose className={TOGGLE_ICON} strokeWidth={STROKE} aria-hidden="true" />
        )}
      </Button>
    </IconTooltip>
  );
  return (
    <div
      className={`app-drag flex items-center ${mini ? `flex-col gap-1 px-0 pb-3 ${hasWindowChrome && !rail ? "pt-4" : "pt-2"}` : "justify-between px-3 pb-3 pt-[14px]"}`}
    >
      <div className={`flex items-center ${mini ? "flex-col gap-2" : "gap-2"}`}>
        {hasWindowChrome ? <WindowChrome className={rail ? "md:hidden" : undefined} /> : null}
        {toggle}
      </div>
      {/* Fits beside the macOS window controls at the narrowest sidebar width. */}
      <div className={`relative flex items-center ${mini ? "flex-col gap-1" : "gap-0.5"}`}>
        {onSearch && !mini ? (
          <IconTooltip label={t`Search`} side={labelSide}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`Search`}
              aria-pressed={searchOpen}
              data-testid="sidebar-search-trigger"
              onClick={onSearch}
              className="app-no-drag text-muted-foreground"
            >
              <Search className={ICON} strokeWidth={STROKE} aria-hidden="true" />
            </Button>
          </IconTooltip>
        ) : null}
        {mini ? null : (
          <IconTooltip label={t`Activity`} side={labelSide}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`Activity`}
              aria-pressed={activityMode}
              data-activity-mode={activityMode ? "on" : "off"}
              onClick={toggleActivityMode}
              className={`app-no-drag ${activityMode ? "bg-accent text-foreground" : "text-muted-foreground"}`}
            >
              {/* A filled bell marks Activity on, so on and hovered never look alike. */}
              <Bell
                className={ICON}
                strokeWidth={STROKE}
                fill={activityMode ? "currentColor" : "none"}
                aria-hidden="true"
              />
            </Button>
          </IconTooltip>
        )}
        <Popover open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
          <IconTooltip label={t`Create`} side={labelSide}>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className={`app-no-drag text-muted-foreground ${railTile}`}
                />
              }
              aria-label={t`Create`}
              data-testid="create-menu-trigger"
            >
              <Plus className={ICON} strokeWidth={STROKE} aria-hidden="true" />
            </PopoverTrigger>
          </IconTooltip>
          {/* Unmount with the state change so the panel it opens never coexists with the menu. */}
          {createMenuOpen ? (
            <PopoverContent
              align="end"
              className="app-no-drag w-auto gap-0 overflow-hidden p-0 data-closed:animate-none"
            >
              <BotCreatePicker
                bots={bots}
                onCreateBot={() => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  setCreateBotOpen(true);
                }}
                onOpenBot={(id) => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  navigate(`/app/${id}`);
                }}
                onCreateGroup={() => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  setPanel("create-group");
                }}
                onCreateSpace={() => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  setNewSpaceOpen(true);
                }}
              />
            </PopoverContent>
          ) : null}
        </Popover>
      </div>
    </div>
  );
}
