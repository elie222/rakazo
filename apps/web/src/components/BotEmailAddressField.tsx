import { Trans, useLingui } from "@lingui/react/macro";
import { parseBotEmailName, suggestedEmailName } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../lib/query/query";
import { useSpaceRpc } from "../lib/query/space-rpc";
import { errorText } from "../lib/query/user-error";
import { CopyTextButton } from "./CopyTextButton";

type BotEmailAddressFieldProps = {
  bot: { id: string; name: string };
  domain: string;
  address: string | null;
  manualCopy?: boolean;
};

/** A bot's email address with a copy button, or the form that claims it for good. */
export function BotEmailAddressField(props: BotEmailAddressFieldProps) {
  // A fresh form per bot, so a name suggested for one bot is never claimed for another.
  return <AddressField key={props.bot.id} {...props} />;
}

function AddressField({ bot, domain, address, manualCopy }: BotEmailAddressFieldProps) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const rpc = useSpaceRpc();
  const queryClient = useQueryClient();
  const [name, setName] = useState(() => suggestedEmailName(bot.name));
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  async function claim() {
    const parsed = parseBotEmailName(name);
    if (parsed.problem) {
      setClaimError(
        {
          length: t`Use 2 to 64 characters`,
          taken: t`That address isn't available`,
          characters: t`Use letters, numbers, dots, dashes or underscores`,
        }[parsed.problem],
      );
      return;
    }
    setClaiming(true);
    setClaimError(null);
    try {
      const claimed = await rpc.bots.claimEmailAddress({ botId: bot.id, name: parsed.name });
      queryClient.setQueryData(
        queries.bots.emailAddress.queryKey({ input: { botId: bot.id } }),
        (current) => (current ? { ...current, address: claimed.address } : current),
      );
      // The Vault lists every bot's address.
      void queryClient.invalidateQueries({ queryKey: queries.bots.emailAddresses.queryKey() });
    } catch (error) {
      setClaimError(errorText(error, t`That address isn't available`));
    } finally {
      setClaiming(false);
    }
  }

  if (address) {
    return (
      <div className="flex items-center gap-1 rounded-lg bg-muted py-0.5 pr-0.5 pl-2.5">
        <span className="min-w-0 flex-1 break-all font-mono text-label text-foreground/75">
          {address}
        </span>
        <CopyTextButton
          text={address}
          copyLabel={t`Copy ${address}`}
          manualCopyLabel={manualCopy ? t`Email address` : undefined}
        />
      </div>
    );
  }
  return (
    <div className="space-y-2.5">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void claim();
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Input
            aria-label={t`Email address`}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setClaimError(null);
            }}
            className="min-w-0 flex-1 font-mono text-label"
          />
          <span className="shrink-0 font-mono text-label text-muted-foreground">@{domain}</span>
        </div>
        <Button type="submit" variant="secondary" size="sm" disabled={claiming || !name}>
          <Trans>Claim</Trans>
        </Button>
      </form>
      {claimError ? (
        <p role="alert" className="text-body-sm text-destructive">
          {claimError}
        </p>
      ) : null}
    </div>
  );
}
