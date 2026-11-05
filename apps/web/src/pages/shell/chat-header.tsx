import { useLingui } from "@lingui/react/macro";
import type { Bot, Group, ThreadSnapshot } from "@rakazo/contracts";
import { BotAvatar, Button, GroupAvatar } from "@rakazo/ui-web";
import { Gift, Menu, Phone } from "lucide-react";
import { useState } from "react";
import { IconTooltip } from "../../components/IconTooltip";
import { InviteDialog } from "../../components/InviteDialog";
import { useBilling } from "../../components/SubscriptionGate";

/** The floating header over the transcript: navigation, the chat's name, call and invite. */
export function ChatHeader({
  inGroup,
  active,
  activeGroup,
  activeSnapshot,
  phoneCallsEnabled,
  voiceReady,
  inCall,
  panelOpen,
  onOpenNavigation,
  onTogglePanel,
  onCall,
  railChrome = false,
}: {
  inGroup: boolean;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  activeSnapshot: ThreadSnapshot | null;
  phoneCallsEnabled: boolean;
  /** False while the voice status loads or no voice is connected; the button then opens voice settings. */
  voiceReady: boolean;
  inCall: boolean;
  panelOpen: boolean;
  onOpenNavigation: () => void;
  onTogglePanel: () => void;
  onCall: (bot: Bot) => void;
  /** The desktop rail is showing: line up with its search button, below the window controls. */
  railChrome?: boolean;
}) {
  const { t } = useLingui();
  const referral = useBilling().status?.referral;
  const [inviteOpen, setInviteOpen] = useState(false);
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 top-0 z-10 grid grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-2 px-3 pb-2.5 desk:px-3.5 [&_button]:pointer-events-auto ${railChrome ? "pt-[35px]" : "pt-3"}`}
    >
      <div className="flex items-center">
        <Button
          variant="floating"
          size="icon-lg"
          aria-label={t`Open navigation`}
          onClick={onOpenNavigation}
          className="app-no-drag desk:hidden"
        >
          <Menu strokeWidth={1.7} className="size-[19px]" />
        </Button>
      </div>
      <Button
        variant="floating"
        data-testid="bot-settings-trigger"
        aria-expanded={panelOpen}
        onClick={onTogglePanel}
        className="app-no-drag h-auto min-w-0 gap-[7px] py-[5px] ps-1.5 pe-3.5 hover:scale-100 active:scale-97"
      >
        {inGroup ? (
          <GroupAvatar
            members={activeSnapshot?.members ?? activeGroup?.members ?? []}
            size={20}
            still
          />
        ) : active ? (
          <BotAvatar
            avatarSet={active.avatarSet}
            color={active.color}
            identity={active.id}
            size={20}
            status={active.status}
            still
          />
        ) : null}
        <span className="min-w-0">
          <span
            className="block truncate text-[13px] leading-[18px] font-medium tracking-[-0.08px] text-foreground"
            dir="auto"
          >
            {inGroup
              ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`)
              : (active?.name ?? t`Select a bot`)}
          </span>
        </span>
      </Button>
      <div className="flex items-center justify-self-end gap-2">
        {phoneCallsEnabled && !inGroup && active ? (
          <IconTooltip label={inCall ? t`Open call` : t`Call`}>
            <Button
              variant="floating"
              size="icon-lg"
              data-testid="call-button"
              aria-label={inCall ? t`Open call` : t`Call`}
              onClick={() => onCall(active)}
              data-active={inCall ? "" : undefined}
              data-voice-ready={voiceReady ? "" : undefined}
              className="app-no-drag"
            >
              <Phone strokeWidth={1.6} className="size-[17px]" />
            </Button>
          </IconTooltip>
        ) : null}
        {referral && !inGroup && active ? (
          <IconTooltip label={t`Invite a friend`}>
            <Button
              variant="floating"
              size="icon-lg"
              aria-label={t`Invite a friend`}
              onClick={() => setInviteOpen(true)}
              className="app-no-drag"
            >
              <Gift strokeWidth={1.6} className="size-[17px]" />
            </Button>
          </IconTooltip>
        ) : null}
      </div>
      {referral ? (
        <InviteDialog referral={referral} open={inviteOpen} onOpenChange={setInviteOpen} />
      ) : null}
    </div>
  );
}
