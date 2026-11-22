import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { Bell, PanelLeftClose, Plus, Search, X } from "lucide-react";
import { IconTooltip } from "../../../components/IconTooltip";
import { WindowChrome } from "../../../components/WindowChrome";
import { desktopBridge } from "../../../lib/platform/desktop";
import { BotCreatePicker } from "../bots/bot-picker";
import type { Panel } from "../right-panel-state";

// A size class, since the Button sizes any svg without one to 16px.
const ICON = "size-4.5";
const STROKE = 1.75;

/**
 * The secondary list's header: the current destination, search, create, and the control
 * that gives the list back to the page. The primary rail owns the window controls.
 */
export function SidebarHeader({
  title,
  isMobile,
  activityMode,
  onToggleActivity,
  createMenuOpen,
  setCreateMenuOpen,
  searchOpen = false,
  onSearch,
  onCollapse,
  onCloseMobile,
  bots,
  setPanel,
  navigate,
  setNewSpaceOpen,
  openAgentImport,
  setCreateBotOpen,
}: {
  title: string;
  isMobile: boolean;
  activityMode: boolean;
  onToggleActivity: () => void;
  createMenuOpen: boolean;
  setCreateMenuOpen: (open: boolean) => void;
  searchOpen?: boolean;
  onSearch?: () => void;
  onCollapse: () => void;
  onCloseMobile: () => void;
  bots: Bot[];
  setPanel: (panel: Panel) => void;
  navigate: (path: string) => void;
  setNewSpaceOpen: (open: boolean) => void;
  openAgentImport: () => void;
  setCreateBotOpen: (open: boolean) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="app-drag flex h-15 shrink-0 items-center gap-1.5 px-3 pb-3 pt-[14px]">
      {isMobile && desktopBridge() ? <WindowChrome /> : null}
      <span className="min-w-0 flex-1 truncate text-body-lg font-medium">{title}</span>
      {isMobile ? (
        <IconTooltip label={t`Activity`} side="inline-end">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t`Activity`}
            aria-pressed={activityMode}
            data-activity-mode={activityMode ? "on" : "off"}
            onClick={onToggleActivity}
            className="app-no-drag text-muted-foreground"
          >
            <Bell
              className={ICON}
              strokeWidth={STROKE}
              fill={activityMode ? "currentColor" : "none"}
              aria-hidden="true"
            />
          </Button>
        </IconTooltip>
      ) : null}
      {onSearch ? (
        <IconTooltip label={activityMode ? t`Search runs` : t`Search`} side="inline-end">
          <Button
            variant="ghost"
            size="icon"
            aria-label={activityMode ? t`Search runs` : t`Search`}
            aria-pressed={searchOpen}
            data-testid="sidebar-search-trigger"
            onClick={onSearch}
            className="app-no-drag text-muted-foreground"
          >
            <Search className={ICON} strokeWidth={STROKE} aria-hidden="true" />
          </Button>
        </IconTooltip>
      ) : null}
      {!activityMode ? (
        <Popover open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
          <IconTooltip label={t`Create`} side="inline-end">
            <PopoverTrigger
              render={
                <Button variant="ghost" size="icon" className="app-no-drag text-muted-foreground" />
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
                  if (isMobile) onCloseMobile();
                  setCreateBotOpen(true);
                }}
                onImportAgent={() => {
                  setCreateMenuOpen(false);
                  if (isMobile) onCloseMobile();
                  openAgentImport();
                }}
                onOpenBot={(id) => {
                  setCreateMenuOpen(false);
                  if (isMobile) onCloseMobile();
                  navigate(`/app/${id}`);
                }}
                onCreateGroup={() => {
                  setCreateMenuOpen(false);
                  if (isMobile) onCloseMobile();
                  setPanel("create-group");
                }}
                onCreateSpace={() => {
                  setCreateMenuOpen(false);
                  if (isMobile) onCloseMobile();
                  setNewSpaceOpen(true);
                }}
              />
            </PopoverContent>
          ) : null}
        </Popover>
      ) : null}
      <IconTooltip label={isMobile ? t`Close navigation` : t`Hide chat list`} side="inline-end">
        <Button
          variant="ghost"
          size="icon"
          aria-label={isMobile ? t`Close navigation` : t`Hide chat list`}
          onClick={isMobile ? onCloseMobile : onCollapse}
          className="app-no-drag text-muted-foreground"
        >
          {isMobile ? (
            <X className={ICON} strokeWidth={STROKE} aria-hidden="true" />
          ) : (
            <PanelLeftClose className={ICON} strokeWidth={STROKE} aria-hidden="true" />
          )}
        </Button>
      </IconTooltip>
    </div>
  );
}
