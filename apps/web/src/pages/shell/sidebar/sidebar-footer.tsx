import { Trans, useLingui } from "@lingui/react/macro";
import type { NavLink } from "@rakazo/contracts";
import { ANDROID_APP_STORE_URL, IOS_APP_STORE_URL } from "@rakazo/contracts";
import {
  AppMarkStack,
  Button,
  buttonVariants,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import {
  BookOpen,
  Building2,
  Check,
  ChevronRight,
  Download,
  FolderOpen,
  Gauge,
  Link2,
  LogOut,
  Plug,
  Plus,
  ScrollText,
  Settings,
  Smartphone,
  SquareKanban,
  UserPlus,
  UserRound,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useSidebarUpdate } from "../../../components/DesktopUpdates";
import { IconTooltip } from "../../../components/IconTooltip";
import type { Organization } from "../../../lib/spaces/organizations";

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
  /** How much of the member's allowance is used; the Usage row shows only with one. */
  usage?: string | null;
  onUsage?: () => void;
  onInvite?: () => void;
  onLogOut: () => void;
  signingOut: boolean;
  logOutError: string | null;
  organizations?: Organization[];
  activeOrganizationId?: string | null;
  onSwitchOrganization?: (organization: Organization) => void;
  onCreateOrganization?: () => void;
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
  usage,
  onUsage,
  onInvite,
  onLogOut,
  signingOut,
  logOutError,
  organizations = [],
  activeOrganizationId,
  onSwitchOrganization,
  onCreateOrganization,
}: Props) {
  const { t } = useLingui();
  const update = useSidebarUpdate();
  const [failedImage, setFailedImage] = useState<string | null>(null);
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
          data-testid="user-menu-trigger"
          aria-label={t`Account menu for ${name}`}
          className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-secondary text-body font-semibold text-secondary-foreground outline-none hover:ring-2 hover:ring-foreground/15 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {image && failedImage !== image ? (
            <img
              src={image}
              alt=""
              className="size-full object-cover"
              onError={() => setFailedImage(image)}
            />
          ) : initials ? (
            initials
          ) : (
            <UserRound size={18} aria-hidden="true" />
          )}
        </PopoverTrigger>
        {open ? (
          <PopoverContent
            side="top"
            sideOffset={8}
            align="start"
            className="max-h-(--available-height) w-[295px] max-w-[calc(100vw-69px)] gap-0 overflow-y-auto p-1 *:shrink-0 data-closed:animate-none"
          >
            <div
              data-testid="account-menu-header"
              className="mb-1 min-w-0 border-b border-border px-2.5 py-2.5"
            >
              <p className="truncate text-body font-medium">{name}</p>
              {email && email !== name ? (
                <p className="truncate text-label text-muted-foreground">{email}</p>
              ) : null}
            </div>
            <OrganizationRow
              organizations={organizations}
              activeOrganizationId={activeOrganizationId}
              onSwitch={onSwitchOrganization}
              onCreate={onCreateOrganization}
            />
            {mini ? (
              <Button
                variant="ghost"
                size="lg"
                className="w-full justify-start gap-2.5 font-normal"
                onClick={onIntegrations}
              >
                <Plug className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Connect apps</Trans>
              </Button>
            ) : null}
            {usage ? (
              <Button
                variant="ghost"
                size="lg"
                className="w-full justify-start gap-2.5 font-normal"
                onClick={onUsage}
              >
                <Gauge className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Usage</Trans>
                <span className="ms-auto text-body-sm tabular-nums text-muted-foreground">
                  {usage}
                </span>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="lg"
              className="w-full justify-start gap-2.5 font-normal"
              aria-label={t`Settings`}
              onClick={onSettings}
            >
              <Settings className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Settings</Trans>
            </Button>
            <Button
              variant="ghost"
              size="lg"
              className="w-full justify-start gap-2.5 font-normal"
              onClick={onSkills}
            >
              <ScrollText className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Skills</Trans>
            </Button>
            <Button
              variant="ghost"
              size="lg"
              className="w-full justify-start gap-2.5 font-normal"
              onClick={onArtifacts}
            >
              <FolderOpen className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Artifacts</Trans>
            </Button>
            {onBoard ? (
              <Button
                variant="ghost"
                size="lg"
                className="w-full justify-start gap-2.5 font-normal"
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
                size="lg"
                className="w-full justify-start gap-2.5 font-normal"
                onClick={() => onLink?.(link)}
              >
                <Link2 className="text-muted-foreground" strokeWidth={1.75} />
                {link.label}
              </Button>
            ))}
            <div className="my-1 border-t border-border" />
            <a
              className={`${buttonVariants({ variant: "ghost", size: "lg" })} w-full justify-start gap-2.5 font-normal`}
              href={
                /Android/i.test(navigator.userAgent) ? ANDROID_APP_STORE_URL : IOS_APP_STORE_URL
              }
              target="_blank"
              rel="noreferrer"
            >
              <Smartphone className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Get the mobile app</Trans>
            </a>
            {onInvite ? (
              <Button
                variant="ghost"
                size="lg"
                className="w-full justify-start gap-2.5 font-normal"
                onClick={onInvite}
              >
                <UserPlus className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Invite friends</Trans>
              </Button>
            ) : null}
            <a
              className={`${buttonVariants({ variant: "ghost", size: "lg" })} w-full justify-start gap-2.5 font-normal`}
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
              size="lg"
              className="w-full justify-start gap-2.5 font-normal"
              disabled={signingOut}
              onClick={onLogOut}
            >
              <LogOut className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Log out</Trans>
            </Button>
            {logOutError ? (
              <p role="alert" className="px-2.5 pt-1 pb-2 text-body-sm text-destructive">
                {logOutError}
              </p>
            ) : null}
          </PopoverContent>
        ) : null}
      </Popover>
      {!mini ? (
        <Button
          variant="secondary"
          ref={pillRef}
          onClick={onIntegrations}
          size="lg"
          className="min-w-0 flex-1 justify-between"
        >
          <span ref={labelRef} className="flex min-w-0 items-center gap-2">
            <Plug className="text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
            <span className="truncate">
              <Trans>Connect apps</Trans>
            </span>
          </span>
          <AppMarkStack
            marks={logos.slice(0, markCount)}
            // The secondary button's surface, at rest and on hover.
            ringClassName="ring-secondary group-hover/button:ring-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]"
          />
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

/** The organization in use; its submenu switches to another or starts a new one. */
function OrganizationRow({
  organizations,
  activeOrganizationId,
  onSwitch,
  onCreate,
}: {
  organizations: Organization[];
  activeOrganizationId?: string | null;
  onSwitch?: (organization: Organization) => void;
  onCreate?: () => void;
}) {
  const active = organizations.find((organization) => organization.id === activeOrganizationId);
  if (!active) return null;
  return (
    <>
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={100}
          data-testid="organization-menu-trigger"
          render={
            <Button
              variant="ghost"
              size="lg"
              className="w-full justify-start gap-2.5 font-normal"
            />
          }
        >
          <Building2 className="text-muted-foreground" strokeWidth={1.75} />
          <span className="min-w-0 truncate">{active.name}</span>
          <ChevronRight className="ms-auto text-muted-foreground" strokeWidth={1.75} />
        </PopoverTrigger>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={4}
          className="max-h-(--available-height) w-60 gap-0 overflow-y-auto p-1 *:shrink-0"
        >
          {organizations.map((organization) => {
            const current = organization.id === active.id;
            return (
              <Button
                key={organization.id}
                variant="ghost"
                aria-current={current ? "true" : undefined}
                size="lg"
                className="w-full justify-between gap-2.5 font-normal"
                onClick={() => onSwitch?.(organization)}
              >
                <span className="min-w-0 truncate">{organization.name}</span>
                {current ? <Check aria-hidden="true" strokeWidth={1.75} /> : null}
              </Button>
            );
          })}
          {onCreate ? (
            <>
              <div className="my-1 border-t border-border" />
              <Button
                variant="ghost"
                size="lg"
                className="w-full justify-start gap-2.5 font-normal"
                onClick={onCreate}
              >
                <Plus className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>New organization</Trans>
              </Button>
            </>
          ) : null}
        </PopoverContent>
      </Popover>
      <div className="my-1 border-t border-border" />
    </>
  );
}
