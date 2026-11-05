import { useLingui } from "@lingui/react/macro";
import { SidebarProvider } from "@rakazo/ui-web";
import type { ComponentProps } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { BOTS_SIDEBAR_DEFAULT_WIDTH } from "../../lib/bots-sidebar-pref";
import type { ColumnLayout } from "../../lib/column-layout";
import { ColumnLayoutContext, columnsFor } from "../../lib/column-layout";
import { useViewportWidth } from "../../lib/use-viewport-width";
import { useSidebarResize } from "./use-sidebar-resize";

const SidebarWidthContext = createContext(BOTS_SIDEBAR_DEFAULT_WIDTH);

export function useBotsSidebarWidth() {
  return useContext(SidebarWidthContext);
}

export function BotsSidebarLayout({
  userId,
  collapsed,
  onCollapsedChange,
  onPreviewCollapsedChange,
  onAutoRailChange,
  computerOpen,
  children,
  ...props
}: ComponentProps<typeof SidebarProvider> & {
  userId: string | null | undefined;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onPreviewCollapsedChange: (collapsed: boolean) => void;
  /** The window, not the user, has put the sidebar on the rail (or taken it off). */
  onAutoRailChange?: (autoRail: boolean) => void;
  computerOpen: boolean;
}) {
  const { t } = useLingui();
  const { width, resizing, handleProps } = useSidebarResize({
    userId,
    collapsed,
    onCollapsedChange,
    onPreviewCollapsedChange,
  });
  const viewportWidth = useViewportWidth();
  const [panelRequest, setPanelRequest] = useState({ open: false, width: 0, priority: false });
  const { sidebarWidth, rail, autoRail, panelWidth, panelFolded } = columnsFor({
    viewportWidth,
    sidebarWidth: width,
    sidebarRail: collapsed,
    panelOpen: panelRequest.open,
    panelWidth: panelRequest.width,
    panelPriority: panelRequest.priority,
  });
  useEffect(() => onAutoRailChange?.(autoRail), [onAutoRailChange, autoRail]);
  const layout = useMemo<ColumnLayout>(
    () => ({ sidebarWidth, rail, autoRail, panelWidth, panelFolded, setPanelRequest }),
    [sidebarWidth, rail, autoRail, panelWidth, panelFolded],
  );
  return (
    <ColumnLayoutContext value={layout}>
      <SidebarWidthContext value={sidebarWidth}>
        <SidebarProvider
          {...props}
          open={!rail}
          onOpenChange={(open) => onCollapsedChange(!open)}
          data-resizing-sidebar={resizing || undefined}
        >
          {children}
          {/* The full-screen computer covers the sidebar, so its edge must not catch clicks there. */}
          {computerOpen ? null : (
            <hr
              {...handleProps}
              aria-valuenow={sidebarWidth}
              data-testid="bots-sidebar-edge"
              aria-label={t`Resize bots sidebar`}
              style={{ insetInlineStart: sidebarWidth - 4 }}
              className={`absolute inset-y-0 z-50 m-0 hidden h-full w-2 border-0 cursor-col-resize touch-none select-none hover:bg-sidebar-border focus-visible:bg-sidebar-border focus-visible:outline-none desk:block ${resizing ? "" : "transition-[inset-inline-start] duration-450 ease-settle motion-reduce:transition-none"}`}
            />
          )}
        </SidebarProvider>
      </SidebarWidthContext>
    </ColumnLayoutContext>
  );
}
