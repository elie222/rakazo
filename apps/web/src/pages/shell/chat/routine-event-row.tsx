import { useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { MessageBlock } from "@rakazo/contracts";
import { isIdentityConfirmationRequired } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { KeyRound } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useIdentityConfirmation } from "../../../components/account/ConfirmIdentityDialog";
import { REVEAL_MS } from "../../../components/vault/VaultItemDetail";
import type { createSpaceRpc } from "../../../lib/query/rpc";
import { errorCode, errorText } from "../../../lib/query/user-error";
import { appBotInboundUrl, useInboundOrigin } from "../../../lib/routines/inbound-url";
import { InboundKeyRows } from "../../routines/routine-editor/trigger-cards";

type RoutineEventBlock = Extract<MessageBlock, { kind: "routine_event" }>;

/** The one-line chat row for a routine that was created, changed, switched on or off, or deleted. */
export function RoutineEventRow({
  block,
  botId,
  rpc,
}: {
  block: RoutineEventBlock;
  /** The bot whose webhook key a webhook routine's row can show. */
  botId?: string;
  rpc?: ReturnType<typeof createSpaceRpc>;
}) {
  const { t } = useLingui();
  const name = block.name;
  const label = {
    created: t`Created routine "${name}"`,
    updated: t`Updated routine "${name}"`,
    enabled: t`Enabled routine "${name}"`,
    disabled: t`Disabled routine "${name}"`,
    deleted: t`Deleted routine "${name}"`,
  }[block.change];
  const text = (
    <span dir="auto" className="min-w-0 break-words text-center">
      {label}
    </span>
  );
  return (
    <div
      data-testid="routine-event-row"
      data-change={block.change}
      className="flex flex-col items-center gap-1.5 py-0.5"
    >
      {block.webhook && botId && rpc ? (
        <WebhookKey botId={botId} rpc={rpc}>
          {text}
        </WebhookKey>
      ) : (
        <div className="flex max-w-full justify-center text-body text-muted-foreground">{text}</div>
      )}
    </div>
  );
}

/**
 * The row's label with a key button that shows the bot's webhook URL and reads its key back, as
 * the routine editor does. The key hides again after a while.
 */
function WebhookKey({
  botId,
  rpc,
  children,
}: {
  botId: string;
  rpc: ReturnType<typeof createSpaceRpc>;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const inboundOrigin = useInboundOrigin();
  const { withIdentityConfirmation, cancel, identityDialog } = useIdentityConfirmation();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on hide, close and unmount, so a reveal still on its way never shows the key again.
  const attempt = useRef(0);
  // The attempt a reveal is running for, so a second tap waits on it instead of starting another.
  const revealing = useRef<number | null>(null);
  useTimeout(hide, secret ? REVEAL_MS : null, secret);
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    [],
  );

  function hide() {
    attempt.current += 1;
    setSecret(null);
  }
  function toggle() {
    if (open) {
      hide();
      cancel();
      setError(null);
      setOpen(false);
      return;
    }
    setOpen(true);
    void reveal();
  }
  async function reveal() {
    if (revealing.current === attempt.current) return;
    const current = ++attempt.current;
    revealing.current = current;
    setError(null);
    try {
      // A reveal the person closed meanwhile asks for nothing: it ends before any prompt opens.
      const revealed = await withIdentityConfirmation(() =>
        rpc.bots.revealWebhookSecret({ botId }).catch((error: unknown) => {
          throw attempt.current === current ? error : new Error("closed");
        }),
      );
      if (attempt.current === current) setSecret(revealed.secret);
    } catch (caught) {
      // Closing the confirmation is a choice; the key stays hidden and can be asked for again.
      if (attempt.current !== current || isIdentityConfirmationRequired(caught)) return;
      setError(
        errorCode(caught) === "FORBIDDEN"
          ? t`Only the bot's creator can see its webhook key.`
          : errorText(caught, t`Could not show the webhook key`),
      );
    } finally {
      if (revealing.current === current) revealing.current = null;
    }
  }

  return (
    <>
      <div className="flex max-w-full items-center justify-center gap-1 text-body text-muted-foreground">
        {children}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={open ? t`Hide webhook key` : t`Show webhook key`}
          aria-expanded={open}
          onClick={toggle}
          className="text-muted-foreground"
        >
          <KeyRound />
        </Button>
      </div>
      {open ? (
        <div className="w-full max-w-md">
          <InboundKeyRows
            kind="webhook"
            path={appBotInboundUrl(inboundOrigin, botId, "webhook")}
            secret={secret}
            onReveal={() => void reveal()}
            onHide={hide}
          />
          {error ? (
            <p role="alert" className="mt-1.5 px-0.5 text-body-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
      {identityDialog}
    </>
  );
}
