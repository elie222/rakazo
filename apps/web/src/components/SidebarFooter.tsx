import { Trans, useLingui } from "@lingui/react/macro";
import type { NavLink, SavedAccountSummary } from "@rakazo/contracts";
import { ANDROID_APK_URL, IOS_APP_STORE_URL } from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import {
  AppMarkStack,
  Badge,
  Button,
  buttonVariants,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import {
  BookOpen,
  Check,
  Download,
  FolderOpen,
  Gauge,
  Link2,
  LogOut,
  Plug,
  ScrollText,
  Settings,
  Smartphone,
  SquareKanban,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { AccountAvatar } from "./AccountAvatar";
import { useSidebarUpdate } from "./DesktopUpdates";
import { IconTooltip } from "./IconTooltip";

type Props = {
  mini?: boolean;
  name: string;
  initials: string | null;
  image?: string | null;
  logos?: Array<{ name: string; logo?: string | null }>;
  email?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIntegrations: () => void;
  onSkills: () => void;
  onBoard?: () => void;
  links?: NavLink[];
  onLink?: (link: NavLink) => void;
  onArtifacts: () => void;
  onSettings: () => void;
  onUsage: () => void;
  onInvite?: () => void;
  onLogOut: () => void;
  signingOut: boolean;
  logOutError: string | null;
  accounts?: SavedAccountSummary[];
  activeUserId?: string | null;
  onSwitchAccount?: (userId: string) => void;
  onAddAccount?: () => void;
  onLogOutAll?: () => void;
};

// Marks are 24px wide, overlap by 2px, and need 2px for the outer ring.
export function sidebarMarkCount(availableWidth: number) {
  return Math.max(0, Math.min(3, Math.floor((availableWidth - 26) / 22) + 1));
}

export function SidebarFooter({
  mini = false,
  name,
  initials,
  image,
  logos = [],
  email,
  open,
  onOpenChange,
  onIntegrations,
  onSkills,
  onBoard,
  links = [],
  onLink,
  onArtifacts,
  onSettings,
  onUsage,
  onInvite,
  onLogOut,
  signingOut,
  logOutError,
  accounts = [],
  activeUserId,
  onSwitchAccount,
  onAddAccount,
  onLogOutAll,
}: Props) {
  const { t } = useLingui();
  const update = useSidebarUpdate();
  const otherAccounts = accounts.filter((account) => account.userId !== activeUserId);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [markCount, setMarkCount] = useState(3);
  useLayoutEffect(() => {
    const pill = pillRef.current;
    const label = labelRef.current;
    if (!pill || !label || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const style = getComputedStyle(pill);
      const available =
        pill.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight) -
        label.scrollWidth -
        Number.parseFloat(style.columnGap);
      setMarkCount(sidebarMarkCount(available));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(pill);
    observer.observe(label);
    measure();
    return () => observer.disconnect();
  }, [mini]);
  return (
    <div
      data-testid="sidebar-footer"
      className={`flex shrink-0 items-center gap-2 bg-transparent ${mini ? "flex-col px-1 py-2" : "px-2.5 py-3"}`}
    >
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          ref={menuTriggerRef}
          data-testid="user-menu-trigger"
          aria-label={t`Account menu for ${name}`}
          className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-sidebar-accent text-sm outline-none hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <AccountAvatar image={image} initials={initials} className="size-full border-0" />
        </PopoverTrigger>
        {open ? (
          <PopoverContent
            side="top"
            sideOffset={8}
            align="start"
            className="max-h-(--available-height) w-[295px] max-w-[calc(100vw-69px)] gap-0 overflow-y-auto p-1 *:shrink-0 data-closed:animate-none"
          >
            <div data-testid="account-menu-header" className="min-w-0 px-2.5 py-2">
              <p className="truncate text-sm font-medium">{name}</p>
              {email && email !== name ? (
                <p className="truncate text-xs text-muted-foreground">{email}</p>
              ) : null}
            </div>
            {onAddAccount || otherAccounts.length > 0 ? (
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                disabled={signingOut}
                aria-haspopup="dialog"
                onClick={() => {
                  onOpenChange(false);
                  setSwitcherOpen(true);
                }}
              >
                <UsersRound className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Switch accounts</Trans>
              </Button>
            ) : null}
            <div className="my-1 border-t border-border" />
            {mini ? (
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                onClick={onIntegrations}
              >
                <Plug className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Connect apps</Trans>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              aria-label={t`Settings`}
              onClick={onSettings}
            >
              <Settings className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Settings</Trans>
            </Button>
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              onClick={onSkills}
            >
              <ScrollText className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Skills</Trans>
            </Button>
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              onClick={onArtifacts}
            >
              <FolderOpen className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Artifacts</Trans>
            </Button>
            {onBoard ? (
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                onClick={onBoard}
              >
                <SquareKanban className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Board</Trans>
              </Button>
            ) : null}
            {links.map((link) => (
              <Button
                key={link.id}
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                onClick={() => onLink?.(link)}
              >
                <Link2 className="text-muted-foreground" strokeWidth={1.75} />
                {link.label}
              </Button>
            ))}
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              onClick={onUsage}
            >
              <Gauge className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Usage</Trans>
            </Button>
            <div className="my-1 border-t border-border" />
            <a
              className={`${buttonVariants({ variant: "ghost" })} h-9 w-full justify-start gap-2.5 font-normal`}
              href={/Android/i.test(navigator.userAgent) ? ANDROID_APK_URL : IOS_APP_STORE_URL}
              target="_blank"
              rel="noreferrer"
            >
              <Smartphone className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Get the mobile app</Trans>
            </a>
            {onInvite ? (
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                onClick={onInvite}
              >
                <UserPlus className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Invite friends</Trans>
              </Button>
            ) : null}
            <a
              className={`${buttonVariants({ variant: "ghost" })} h-9 w-full justify-start gap-2.5 font-normal`}
              href="https://github.com/elie222/rakazo/blob/main/docs/self-host.md"
              target="_blank"
              rel="noreferrer"
            >
              <BookOpen className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Docs</Trans>
            </a>
            <div className="my-1 border-t border-border" />
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              disabled={signingOut}
              onClick={onLogOut}
            >
              <LogOut className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Log out</Trans>
            </Button>
            {otherAccounts.length && onLogOutAll ? (
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                disabled={signingOut}
                onClick={onLogOutAll}
              >
                <LogOut className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Log out all accounts</Trans>
              </Button>
            ) : null}
            {logOutError ? (
              <p role="alert" className="px-2.5 pt-1 pb-2 text-[13px] text-destructive">
                {logOutError}
              </p>
            ) : null}
          </PopoverContent>
        ) : null}
      </Popover>
      <Dialog open={switcherOpen} onOpenChange={setSwitcherOpen}>
        <DialogContent
          finalFocus={menuTriggerRef}
          showCloseButton={false}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Switch accounts</Trans>
            </DialogTitle>
          </DialogHeader>
          <DialogClose
            aria-label={t`Close`}
            render={
              <Button variant="ghost" className="absolute top-4.5 right-4.5" size="icon-sm" />
            }
          >
            <X aria-hidden="true" />
          </DialogClose>
          <div className="min-w-0">
            {accounts.map((account) => {
              const display = accountDisplay(account, account.email);
              const selected = account.userId === activeUserId;
              return (
                <Button
                  key={account.userId}
                  variant="ghost"
                  className="h-auto w-full justify-start gap-2.5 py-2 font-normal disabled:opacity-100"
                  aria-current={selected ? "true" : undefined}
                  disabled={signingOut || selected}
                  onClick={() => {
                    setSwitcherOpen(false);
                    onSwitchAccount?.(account.userId);
                  }}
                >
                  <AccountAvatar
                    image={display.image}
                    initials={display.initial}
                    className="size-6 text-[11px]"
                  />
                  <span className="min-w-0 flex-1 text-start">
                    <span className="block truncate">{display.label}</span>
                    {display.label !== account.email ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {account.email}
                      </span>
                    ) : null}
                  </span>
                  <span className="grid size-4 shrink-0 place-items-center">
                    {selected ? <Check aria-hidden="true" size={16} /> : null}
                  </span>
                  {account.unread > 0 ? (
                    <Badge variant="secondary" className="tabular-nums">
                      {account.unread}
                    </Badge>
                  ) : null}
                </Button>
              );
            })}
            {onAddAccount ? (
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                disabled={signingOut}
                onClick={() => {
                  setSwitcherOpen(false);
                  onAddAccount();
                }}
              >
                <UserPlus className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Add account</Trans>
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
      {!mini ? (
        <Button
          variant="outline"
          ref={pillRef}
          onClick={onIntegrations}
          className="h-9 min-w-0 flex-1 justify-between bg-sidebar-accent hover:border-foreground/30 hover:bg-sidebar-accent dark:hover:bg-sidebar-accent"
        >
          <span ref={labelRef} className="min-w-0 truncate">
            <Trans>Connect apps</Trans>
          </span>
          <AppMarkStack marks={logos.slice(0, markCount)} ringClassName="ring-sidebar-accent" />
        </Button>
      ) : null}
      {update.available ? (
        <IconTooltip label={t`Install update`}>
          <Button
            size="icon-lg"
            className="rounded-full"
            aria-label={t`Install update`}
            disabled={update.busy}
            onClick={update.install}
          >
            <Download aria-hidden="true" />
          </Button>
        </IconTooltip>
      ) : null}
    </div>
  );
}
