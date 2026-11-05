import { Trans, useLingui } from "@lingui/react/macro";
import { BOT_EMAIL_NAME_TAKEN, BotEmailNameSchema, suggestedEmailName } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useCopyText } from "../lib/copy-text";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/** A bot's email address with a copy button, or the form that claims it for good. */
export function BotEmailAddressField({
  bot,
  domain,
  address,
}: {
  bot: { id: string; name: string };
  domain: string;
  address: string | null;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const [copied, copy] = useCopyText();
  const [name, setName] = useState(() => suggestedEmailName(bot.name));
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  async function claim() {
    const parsed = BotEmailNameSchema.safeParse(name);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setClaimError(
        issue?.code === "too_small" || issue?.code === "too_big"
          ? t`Use 2 to 64 characters`
          : issue?.message === BOT_EMAIL_NAME_TAKEN
            ? t`That address isn't available`
            : t`Use letters, numbers, dots, dashes or underscores`,
      );
      return;
    }
    setClaiming(true);
    setClaimError(null);
    try {
      const claimed = await rpc.bots.claimEmailAddress({ botId: bot.id, name: parsed.data });
      queryClient.setQueryData(
        queries.bots.emailAddress.queryKey({ input: { botId: bot.id } }),
        (current) => (current ? { ...current, address: claimed.address } : current),
      );
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
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={copied ? t`Copied` : t`Copy ${address}`}
          onClick={() => copy(address)}
          className="text-muted-foreground"
        >
          {copied ? <Check /> : <Copy />}
        </Button>
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
