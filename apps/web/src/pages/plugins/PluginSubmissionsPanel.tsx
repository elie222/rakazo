import { Trans, useLingui } from "@lingui/react/macro";
import type {
  PluginSubmission,
  PluginSubmissionReview,
  PluginSubmissionStatus,
} from "@rakazo/contracts";
import { integrationPageUrl } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Disclosure,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { PluginLogo } from "../../components/integrations/plugin-marketplace";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";

function ExternalLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-w-0 items-center gap-1 text-muted-foreground hover:text-foreground"
    >
      <span className="truncate">{href.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
      <ArrowUpRight size={14} className="shrink-0" />
    </a>
  );
}

export function PluginSubmissionsPanel() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [status, setStatus] = useState<PluginSubmissionStatus>("pending");
  const [rejecting, setRejecting] = useState<PluginSubmission | null>(null);
  const [reason, setReason] = useState("");
  const submissions = useQuery(queries.marketplace.submissions.queryOptions({ input: { status } }));
  const review = useSave({
    save: (input: PluginSubmissionReview, rpc) => rpc.marketplace.review(input),
    stale: [queries.marketplace.submissions.key(), queries.marketplace.catalog.key()],
    onSaved: (_reviewed, input) => {
      if (input.decision === "reject") setRejecting(null);
    },
    onFailed: (error, input) =>
      toast.error(
        errorText(
          error,
          input.decision === "reject" ? t`Could not reject plugin` : t`Could not approve plugin`,
        ),
      ),
  });

  function reject(event: FormEvent) {
    event.preventDefault();
    if (!rejecting || !reason.trim()) return;
    review.run({ id: rejecting.id, decision: "reject", reason: reason.trim() });
  }

  const list = submissions.data ?? [];

  return (
    <div data-testid="plugin-submissions" className="space-y-6">
      <Tabs value={status} onValueChange={(value) => setStatus(value as PluginSubmissionStatus)}>
        <TabsList>
          <TabsTrigger value="pending" className="px-3">
            <Trans>Pending</Trans>
          </TabsTrigger>
          <TabsTrigger value="approved" className="px-3">
            <Trans>Approved</Trans>
          </TabsTrigger>
          <TabsTrigger value="rejected" className="px-3">
            <Trans>Rejected</Trans>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {submissions.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      ) : submissions.isError ? (
        <div role="alert" className="flex items-center gap-3 text-body text-destructive">
          {errorText(submissions.error, t`Couldn't load submissions`)}
          <Button variant="outline" size="sm" onClick={() => void submissions.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : list.length === 0 ? (
        <p className="text-body text-muted-foreground">
          <Trans>No submissions</Trans>
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {list.map((submission) => (
            <li
              key={submission.id}
              data-testid="plugin-submission"
              aria-label={submission.name}
              className="space-y-3 px-4 py-4"
            >
              <div className="flex items-start gap-3">
                <PluginLogo
                  name={submission.name}
                  logo={submission.logo}
                  site={submission.website}
                />
                <div className="min-w-0 flex-1 space-y-0.5 text-body-sm">
                  <h3 className="truncate text-body-lg font-medium text-foreground">
                    {submission.name}
                  </h3>
                  {submission.source ? <ExternalLink href={submission.source} /> : null}
                  {submission.claim ? (
                    <ExternalLink href={integrationPageUrl(submission.claim)} />
                  ) : null}
                  {submission.website ? (
                    <div>
                      <ExternalLink href={submission.website} />
                    </div>
                  ) : null}
                  <a
                    href={`mailto:${submission.email}`}
                    className="block truncate text-muted-foreground hover:text-foreground"
                  >
                    {submission.email}
                  </a>
                </div>
                {submission.status === "pending" ? (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={review.pending}
                      onClick={() => {
                        setReason("");
                        setRejecting(submission);
                      }}
                    >
                      <Trans>Reject</Trans>
                    </Button>
                    <Button
                      size="sm"
                      disabled={review.pending}
                      onClick={() => review.run({ id: submission.id, decision: "approve" })}
                    >
                      {review.pending && review.input?.id === submission.id ? (
                        <Trans>Approving…</Trans>
                      ) : (
                        <Trans>Approve</Trans>
                      )}
                    </Button>
                  </div>
                ) : null}
              </div>
              {submission.description ? (
                <p className="whitespace-pre-wrap text-body leading-6 text-foreground" dir="auto">
                  {submission.description}
                </p>
              ) : null}
              {submission.testing ? (
                <Disclosure
                  summary={<Trans>Testing</Trans>}
                  summaryClassName="text-body-sm text-muted-foreground"
                >
                  <p
                    className="mt-2 whitespace-pre-wrap text-body-sm leading-5 text-muted-foreground"
                    dir="auto"
                  >
                    {submission.testing}
                  </p>
                </Disclosure>
              ) : null}
              {submission.reason ? (
                <p className="text-body-sm text-destructive" dir="auto">
                  {submission.reason}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={rejecting !== null}
        onOpenChange={(open) => {
          if (!open && !review.pending) setRejecting(null);
        }}
      >
        <DialogContent>
          <form onSubmit={reject} className="space-y-4">
            <DialogHeader>
              <DialogTitle>
                <Trans>Reject {rejecting?.name}</Trans>
              </DialogTitle>
            </DialogHeader>
            <Textarea
              aria-label={t`Reason`}
              placeholder={t`Reason`}
              value={reason}
              maxLength={1000}
              required
              autoFocus
              onChange={(event) => setReason(event.target.value)}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={review.pending}
                onClick={() => setRejecting(null)}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={review.pending || !reason.trim()}
              >
                {review.pending ? <Trans>Rejecting…</Trans> : <Trans>Reject</Trans>}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
