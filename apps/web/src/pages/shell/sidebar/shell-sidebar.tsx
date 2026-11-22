import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group } from "@rakazo/contracts";
import { formatBillingDate } from "@rakazo/i18n/billing";
import {
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  Sidebar,
} from "@rakazo/ui-web";
import { Search, SlidersHorizontal } from "lucide-react";
import type { CSSProperties, ReactNode, UIEvent } from "react";
import { useEffect, useMemo, useRef } from "react";
import { PasskeyOffer } from "../../../components/account/PasskeyOffer";
import { useBilling } from "../../../components/billing/SubscriptionGate";
import { emptyActivityFilters } from "../../../lib/activity-list-filters";
import type { BotsSidebarDensity } from "../../../lib/preferences/bots-sidebar-density-pref";
import { ActivityList } from "../../space/ActivityList";
import { SpaceSearchResults } from "../../space/SpaceSearch";
import { useAppRail } from "../app-rail";
import type { ChatMenuState } from "../chat/chat-context-menu";
import type { Panel } from "../right-panel-state";
import { focusChatListRestore } from "./focus-chat-list";
import { SidebarHeader } from "./sidebar-header";
import { useFlip } from "./use-flip";
import type { SidebarSearch } from "./use-sidebar-search";

/** Focuses the search box once it renders, its text selected so typing replaces it. */
export function focusSidebarSearch() {
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>('input[name="sidebar-search"]');
    input?.focus();
    input?.select();
  });
}

/**
 * Chromium keeps the top fade drawn when collapsing sections shrinks a scrolled list until it no
 * longer scrolls; replaying the fade's scroll-driven animations lets it settle at the top.
 */
function resetFadeWhenUnscrollable(event: UIEvent<HTMLDivElement>) {
  const list = event.currentTarget;
  if (list.scrollHeight > list.clientHeight) return;
  for (const animation of list.getAnimations()) {
    animation.cancel();
    animation.play();
  }
}

/** The bots sidebar: a drawer on phones, collapsible to icons elsewhere. */
export function ShellSidebar({
  isMobile,
  mobileOpen,
  onCloseMobile,
  density,
  collapsed,
  setCollapsedPref,
  createMenuOpen,
  setCreateMenuOpen,
  search,
  bots,
  groups,
  collapsedSidebarSections,
  toggleSidebarSection,
  setPanel,
  navigate,
  setNewSpaceOpen,
  openAgentImport,
  setCreateBotOpen,
  chatMenu,
  roster,
  archived,
  footer,
}: {
  isMobile: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  density: BotsSidebarDensity;
  collapsed: boolean;
  setCollapsedPref: (collapsed: boolean) => void;
  createMenuOpen: boolean;
  setCreateMenuOpen: (open: boolean) => void;
  search: SidebarSearch;
  bots: Bot[];
  groups: Group[];
  collapsedSidebarSections: ReadonlySet<string>;
  toggleSidebarSection: (key: string) => void;
  setPanel: (panel: Panel) => void;
  navigate: (path: string) => void;
  setNewSpaceOpen: (open: boolean) => void;
  openAgentImport: () => void;
  setCreateBotOpen: (open: boolean) => void;
  chatMenu: ChatMenuState;
  roster: ReactNode;
  archived: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useLingui();
  const rail = useAppRail();
  const listRef = useRef<HTMLDivElement>(null);
  const flipRevision = useMemo(
    () =>
      [
        bots
          .map(
            (bot) =>
              `${bot.id}:${bot.pinned ? 1 : 0}:${bot.sectionId ?? ""}:${bot.spaceId}:${bot.updatedAt}`,
          )
          .join(","),
        groups
          .map(
            (group) =>
              `${group.id}:${group.pinned ? 1 : 0}:${group.sectionId ?? ""}:${group.spaceId}:${group.updatedAt}`,
          )
          .join(","),
      ].join(";"),
    [bots, groups],
  );
  useFlip(listRef, flipRevision);
  const {
    query,
    setQuery,
    searchOpen,
    setSearchOpen,
    searchHits,
    searchLoading,
    searchError,
    retrySearch,
    showSpaceSearch,
    jumpToSearchHit,
    activityMode,
    toggleActivityMode,
    activityFilters,
    setActivityFilters,
    activityFiltersExpanded,
    setActivityFiltersExpanded,
    activityFiltersId,
    activityFilterCount,
  } = search;
  // A closed drawer and a collapsed desktop list are both off screen, so neither may keep focus.
  const listHidden = isMobile ? !mobileOpen : collapsed;
  // Activity replaces the roster; leftovers from Chats must not filter or replace its results.
  useEffect(() => {
    if (!activityMode) return;
    setQuery("");
    setActivityFilters(emptyActivityFilters());
    setActivityFiltersExpanded(false);
  }, [activityMode, setQuery, setActivityFilters, setActivityFiltersExpanded]);
  return (
    <>
      <button
        type="button"
        aria-label={t`Close navigation`}
        aria-hidden={mobileOpen ? undefined : true}
        inert={mobileOpen ? undefined : true}
        tabIndex={mobileOpen ? undefined : -1}
        onClick={onCloseMobile}
        className={`absolute inset-y-0 end-0 start-[min(calc(100%-48px),316px)] z-30 bg-overlay transition-opacity duration-150 ease-out motion-reduce:transition-none md:hidden ${
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <Sidebar
        collapsible={isMobile ? "none" : "offcanvas"}
        side={document.documentElement.dir === "rtl" ? "right" : "left"}
        data-testid="bots-sidebar"
        data-space-switch="sidebar"
        inert={listHidden || undefined}
        aria-hidden={listHidden || undefined}
        style={
          {
            // The list steps aside by its own width from the rail's edge while it slides.
            "--app-rail-offset": "calc(var(--app-rail-width) - var(--sidebar-width))",
          } as CSSProperties
        }
        data-bots-sidebar-density={density}
        data-collapsed={collapsed ? "true" : "false"}
        className={
          isMobile
            ? `absolute inset-y-0 start-0 z-40 flex w-[calc(100%-48px)] max-w-[316px] shrink-0 flex-col border-e border-sidebar-border bg-sidebar transition-transform duration-200 ease-out motion-reduce:transition-none ${mobileOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full"}`
            : // The sidebar is fixed to the window edge, so it steps aside for the rail there.
              `h-full overflow-hidden border-sidebar-border ${
                rail
                  ? "data-[side=left]:left-(--app-rail-width) data-[side=right]:right-(--app-rail-width) data-[side=left]:group-data-[collapsible=offcanvas]:left-(--app-rail-offset) data-[side=right]:group-data-[collapsible=offcanvas]:right-(--app-rail-offset)"
                  : ""
              }`
        }
      >
        <SidebarHeader
          title={activityMode ? t`Activity` : t`Chats`}
          isMobile={isMobile}
          activityMode={activityMode}
          onToggleActivity={toggleActivityMode}
          createMenuOpen={createMenuOpen}
          setCreateMenuOpen={setCreateMenuOpen}
          searchOpen={searchOpen}
          onSearch={() => {
            if (searchOpen) {
              if (activityMode) setActivityFilters({ ...activityFilters, query: "" });
              else setQuery("");
              setSearchOpen(false);
              return;
            }
            setSearchOpen(true);
            focusSidebarSearch();
          }}
          onCollapse={() => {
            setCollapsedPref(true);
            focusChatListRestore();
          }}
          onCloseMobile={onCloseMobile}
          bots={bots}
          setPanel={setPanel}
          navigate={navigate}
          setNewSpaceOpen={setNewSpaceOpen}
          openAgentImport={openAgentImport}
          setCreateBotOpen={setCreateBotOpen}
        />
        {!(
          searchOpen ||
          query ||
          (activityMode && (activityFilterCount > 0 || activityFiltersExpanded))
        ) ? null : (
          <InputGroup
            data-testid="sidebar-search"
            className="mx-2.5 mb-3 w-auto rounded-xl bg-card dark:bg-input border border-border text-muted-foreground focus-within:border-ring"
          >
            <InputGroupAddon>
              <Search size={16} strokeWidth={1.8} aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              value={activityMode ? activityFilters.query : query}
              onChange={(e) => {
                if (activityMode) setActivityFilters({ ...activityFilters, query: e.target.value });
                else setQuery(e.target.value);
              }}
              onKeyDown={(event) => {
                if (
                  event.key !== "Escape" ||
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229
                )
                  return;
                // Handled here, so an open phone drawer stays open for this keypress.
                event.preventDefault();
                if (activityMode) setActivityFilters({ ...activityFilters, query: "" });
                else setQuery("");
                setSearchOpen(false);
              }}
              placeholder={activityMode ? t`Search runs` : t`Search`}
              aria-label={activityMode ? t`Search runs` : t`Search`}
              autoComplete="off"
              name="sidebar-search"
            />
            {activityMode ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-sm"
                  aria-label={t`Filters`}
                  aria-expanded={activityFiltersExpanded}
                  aria-controls={activityFiltersId}
                  onClick={() => setActivityFiltersExpanded((expanded) => !expanded)}
                  className="relative rounded-lg"
                >
                  <SlidersHorizontal size={16} aria-hidden="true" />
                  {activityFilterCount > 0 ? (
                    <span
                      data-testid="activity-filter-indicator"
                      aria-hidden="true"
                      className="absolute end-1 top-1 size-1.5 rounded-full bg-primary"
                    />
                  ) : null}
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
        )}
        <div
          ref={listRef}
          onScroll={resetFadeWhenUnscrollable}
          className="rk-scroll scroll-fade-y scroll-fade-12 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2.5"
        >
          {showSpaceSearch ? (
            <SpaceSearchResults
              hits={searchHits}
              loading={searchLoading}
              error={searchError}
              onRetry={retrySearch}
              onSelect={(hit) => jumpToSearchHit(hit)}
              chatMenu={chatMenu}
            />
          ) : activityMode ? (
            <ActivityList
              bots={bots}
              groups={groups}
              toggledSections={collapsedSidebarSections}
              onToggleSection={toggleSidebarSection}
              onOpenBot={(bot) => {
                onCloseMobile();
                navigate(`/app/${bot.id}`);
              }}
              onOpenGroup={(group) => {
                onCloseMobile();
                navigate(`/app/g/${group.id}`);
              }}
              filters={activityFilters}
              onFiltersChange={setActivityFilters}
              filtersExpanded={activityFiltersExpanded}
              filtersId={activityFiltersId}
              onOpenRun={(run) => {
                onCloseMobile();
                if (run.groupId) navigate(`/app/g/${run.groupId}`);
                else navigate(`/app/${run.botId}`);
              }}
            />
          ) : (
            roster
          )}
        </div>
        {/* One height limit for every shelf, so open shelves never squeeze out the chat list. */}
        <div
          className={
            activityMode
              ? "hidden"
              : "rk-scroll flex max-h-[40vh] shrink-0 flex-col overflow-y-auto px-2.5 pb-1"
          }
        >
          {archived}
        </div>
        <div className="contents">
          <PasskeyOffer />
        </div>
        <SidebarPlanNotice />
        {footer}
      </Sidebar>
    </>
  );
}

/** The list bottom's plan notice; the rail's account menu stays compact. */
function SidebarPlanNotice() {
  const { i18n } = useLingui();
  const { status: billing, showPlans } = useBilling();
  const freeUntil =
    billing?.funding === "byok" &&
    billing.byokFreeUntil &&
    new Date(billing.byokFreeUntil) > new Date()
      ? billing.byokFreeUntil
      : null;
  if (!freeUntil) return null;
  const day = formatBillingDate(freeUntil, i18n.locale || "en");
  return (
    <div className="mx-2.5 flex items-center justify-between gap-2 ps-2.5 text-body text-muted-foreground">
      <span className="min-w-0 truncate">
        <Trans>Free plan ends {day}</Trans>
      </span>
      {billing?.canManage ? (
        <Button variant="outline" size="sm" onClick={showPlans}>
          <Trans>Upgrade</Trans>
        </Button>
      ) : null}
    </div>
  );
}
