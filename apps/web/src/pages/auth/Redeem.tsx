import { Trans, useLingui } from "@lingui/react/macro";
import { formatBillingAmount } from "@rakazo/i18n/billing";
import { Button, cn, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { AuthFrame, submitClass } from "./Auth";

export function RedeemPage() {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const queries = useSpaceQueries();
  const [code, setCode] = useState(useParams().code ?? "");
  const [added, setAdded] = useState<number | null>(null);
  const redeem = useSave({
    save: (input: string, rpc) => rpc.billing.redeemCreditCode({ code: input }),
    stale: [queries.billing.status.key()],
    onSaved: ({ creditCents }) => setAdded(creditCents),
  });

  if (added !== null)
    return (
      <AuthFrame
        title={<Trans>{formatBillingAmount(added, "USD", i18n.locale)} in credits added</Trans>}
        onSubmit={(event) => {
          event.preventDefault();
          navigate("/app", { replace: true });
        }}
      >
        <Button type="submit" size="xl" className={submitClass}>
          <Trans>Open Rakazo</Trans>
        </Button>
      </AuthFrame>
    );

  return (
    <AuthFrame
      title={<Trans>Redeem a code</Trans>}
      onSubmit={(event) => {
        event.preventDefault();
        if (code.trim()) redeem.run(code.trim());
      }}
    >
      <Field className="w-full">
        <FieldLabel htmlFor="redeem-code">
          <Trans>Code</Trans>
        </FieldLabel>
        <Input
          id="redeem-code"
          value={code}
          maxLength={64}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          onChange={(event) => {
            setCode(event.target.value);
            redeem.reset();
          }}
        />
      </Field>
      {redeem.error ? (
        <p role="alert" className="mt-3 self-start text-body-sm text-destructive">
          {errorText(redeem.error, t`Could not redeem the code`)}
        </p>
      ) : null}
      <Button
        type="submit"
        size="xl"
        disabled={redeem.pending || !code.trim()}
        className={cn(submitClass, "mt-6")}
      >
        <Trans>Redeem</Trans>
      </Button>
    </AuthFrame>
  );
}
