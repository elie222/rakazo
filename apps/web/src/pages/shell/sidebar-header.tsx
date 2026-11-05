import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { Bell, Plus, Search } from "lucide-react";
import { IconTooltip } from "../../components/IconTooltip";
import { desktopBridge } from "../../lib/desktop";
import type { Panel } from "../../lib/right-panel-state";
import { WindowChrome } from "../WindowChrome";
import { BotCreatePicker } from "./bot-picker";

/** Round frosted buttons at the top of the sidebar, 34px like the window controls row. */
const GLASS_BUTTON = "app-no-drag size-[34px] rounded-full";

export function SidebarHeader({
  mini = false,
  createMenuOpen,
  setCreateMenuOpen,
  activityMode,
  toggleActivityMode,
  searchOpen = false,
  onSearch,
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
  bots: Bot[];
  setMobileSidebarOpen: (open: boolean) => void;
  setPanel: (panel: Panel) => void;
  navigate: (path: string) => void;
  setNewSpaceOpen: (open: boolean) => void;
  setCreateBotOpen: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const hasWindowChrome = Boolean(desktopBridge());
  return (
    <div
      className={`app-drag flex items-center ${mini ? `flex-col gap-2 px-0 pb-2 ${hasWindowChrome ? "pt-4" : "pt-[13px]"}` : "h-[60px] shrink-0 justify-between ps-[18px] pe-3.5"}`}
    >
      {!mini || hasWindowChrome ? <WindowChrome /> : null}
      <div className={`relative flex items-center ${mini ? "flex-col gap-2" : "gap-2"}`}>
        {onSearch ? (
          <IconTooltip label={t`Search`}>
            <Button
              variant="floating"
              size="icon"
              aria-label={t`Search`}
              aria-pressed={searchOpen}
              data-testid="sidebar-search-trigger"
              onClick={onSearch}
              className={GLASS_BUTTON}
            >
              <Search size={16} strokeWidth={2} aria-hidden="true" />
            </Button>
          </IconTooltip>
        ) : null}
        <IconTooltip label={t`Activity`}>
          <Button
            variant="floating"
            size="icon"
            aria-label={t`Activity`}
            aria-pressed={activityMode}
            data-activity-mode={activityMode ? "on" : "off"}
            onClick={toggleActivityMode}
            className={GLASS_BUTTON}
          >
            {/* A filled bell marks Activity on, so on and hovered never look alike. */}
            <Bell
              size={16}
              strokeWidth={2}
              fill={activityMode ? "currentColor" : "none"}
              aria-hidden="true"
            />
          </Button>
        </IconTooltip>
        <Popover open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
          <IconTooltip label={t`Create`}>
            <PopoverTrigger
              render={<Button variant="floating" size="icon" className={GLASS_BUTTON} />}
              aria-label={t`Create`}
              data-testid="create-menu-trigger"
            >
              <Plus size={16} strokeWidth={2} aria-hidden="true" />
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
