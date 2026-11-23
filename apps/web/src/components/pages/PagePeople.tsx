import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import { useCopyText } from "../../lib/copy-text";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { ManualCopy } from "./SharePopover";

export function PagePeople({ pageId, url }: { pageId: string; url: string | null }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const read = queries.pageReviews.grants.queryOptions({ input: { pageId } });
  const grants = useQuery(read);
  const [email, setEmail] = useState("");
  const [copied, copy, copyFailed] = useCopyText();
  const grant = useSave({
    save: (email: string, rpc) => rpc.pageReviews.grant({ pageId, email }),
    stale: [read.queryKey],
    onSaved: () => setEmail(""),
  });
  const revoke = useSave({
    save: (grantId: string, rpc) => rpc.pageReviews.revoke({ pageId, grantId }),
    stale: [read.queryKey],
  });
  const error = grant.error ?? revoke.error ?? grants.error;
  return (
    <div className="flex max-h-60 flex-col gap-2 overflow-y-auto border-t px-4 pt-3">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          grant.run(email.trim());
        }}
      >
        <Input
          type="email"
          aria-label={t`Account email`}
          placeholder={t`Account email`}
          required
          maxLength={254}
          value={email}
          readOnly={grant.pending}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Button type="submit" disabled={grant.pending || revoke.pending || !email.trim()}>
          <Trans>Add</Trans>
        </Button>
      </form>
      {!grants.isError && grants.data?.length ? (
        <ul className="flex flex-col gap-1">
          {grants.data.map((person) => (
            <li key={person.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-body-sm">{person.email}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={revoke.pending || grant.pending}
                aria-label={t`Remove access for ${person.email}`}
                onClick={() => revoke.run(person.id)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="text-label text-destructive">
          {errorText(error)}
        </p>
      ) : null}
      {url && !grants.isError && grants.data?.length ? (
        copyFailed ? (
          <ManualCopy url={url} />
        ) : (
          <Button variant="outline" onClick={() => copy(url)}>
            {copied ? <Trans>Copied</Trans> : <Trans>Copy review link</Trans>}
          </Button>
        )
      ) : null}
    </div>
  );
}
