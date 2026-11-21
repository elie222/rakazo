import { useLingui } from "@lingui/react/macro";
import type { NavLink } from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import { useState } from "react";
import { useUsageHint } from "../../../components/billing/PlanUsage";
import { useBilling } from "../../../components/billing/SubscriptionGate";
import { CreateOrganizationDialog } from "../../../components/spaces/CreateOrganizationDialog";
import { InviteDialog } from "../../../components/spaces/InviteDialog";
import { useSignOut } from "../../../lib/auth/sign-out";
import { useQueryUserId } from "../../../lib/query/query";
import { switchOrganization, useOrganizations } from "../../../lib/spaces/organizations";
import type { SettingsSection } from "../shell-overlay-url";
import { SidebarFooter } from "./sidebar-footer";

export type SidebarUser = {
  name?: string | null;
  email?: string;
  image?: string | null;
};

export function ShellSidebarFooter({
  mini,
  logos,
  user,
  boardEnabled,
  navLinks,
  closeMobileSidebar,
  navigate,
  openSettings,
  openIntegrations,
  openSkills,
  openSpaceChat,
}: {
  mini: boolean;
  logos: Array<{ name: string; logo?: string | null }>;
  user: SidebarUser | undefined;
  boardEnabled: boolean;
  navLinks: NavLink[];
  closeMobileSidebar: () => void;
  navigate: (path: string) => void;
  openSettings: (section: SettingsSection) => void;
  openIntegrations: () => void;
  openSkills: () => void;
  openSpaceChat: (spaceId: string, path: string) => void;
}) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const { organizations, activeOrganizationId } = useOrganizations();
  const { status: billing } = useBilling();
  const usage = useUsageHint();
  const [menuOpen, setMenuOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [creatingOrganization, setCreatingOrganization] = useState(false);
  const referral = billing?.referral;
  const [logOutError, setLogOutError] = useState<string | null>(null);
  const { signingOut, logOut } = useSignOut("/sign-in", (message) => {
    // A failed sign-out reloads the page: reopen the menu so its error shows.
    setMenuOpen(true);
    setLogOutError(message);
  });
  const { label: userName, initial: initials } = accountDisplay(user ?? {}, t`You`);
  return (
    <>
      <SidebarFooter
        mini={mini}
        logos={logos}
        name={userName}
        initials={initials}
        image={user?.image}
        email={user?.email}
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (!open) setLogOutError(null);
        }}
        onIntegrations={() => {
          setMenuOpen(false);
          openIntegrations();
        }}
        onSkills={() => {
          setMenuOpen(false);
          openSkills();
        }}
        onBoard={
          boardEnabled
            ? () => {
                setMenuOpen(false);
                closeMobileSidebar();
                navigate("/app/board");
              }
            : undefined
        }
        links={navLinks}
        onLink={(link) => {
          setMenuOpen(false);
          closeMobileSidebar();
          navigate(`/app/x/${link.id}`);
        }}
        onSharedPages={() => {
          setMenuOpen(false);
          closeMobileSidebar();
          navigate("/review");
        }}
        onArtifacts={() => {
          setMenuOpen(false);
          closeMobileSidebar();
          navigate("/app/artifacts");
        }}
        onSettings={() => {
          setMenuOpen(false);
          openSettings("general");
        }}
        usage={usage}
        onUsage={() => {
          setMenuOpen(false);
          openSettings("usage");
        }}
        onInvite={
          referral
            ? () => {
                setMenuOpen(false);
                setInviteOpen(true);
              }
            : undefined
        }
        onLogOut={() => {
          setLogOutError(null);
          void logOut();
        }}
        signingOut={signingOut}
        logOutError={logOutError}
        organizations={organizations}
        activeOrganizationId={activeOrganizationId}
        onSwitchOrganization={(organization) => {
          setMenuOpen(false);
          if (organization.id !== activeOrganizationId)
            void switchOrganization(userId, organization, openSpaceChat);
        }}
        onCreateOrganization={() => {
          setMenuOpen(false);
          setCreatingOrganization(true);
        }}
      />
      <CreateOrganizationDialog
        open={creatingOrganization}
        onOpenChange={setCreatingOrganization}
        openSpaceChat={openSpaceChat}
      />
      {referral ? (
        <InviteDialog referral={referral} open={inviteOpen} onOpenChange={setInviteOpen} />
      ) : null}
    </>
  );
}
