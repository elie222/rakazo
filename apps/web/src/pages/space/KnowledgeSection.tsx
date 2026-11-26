import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { MemoryDocument } from "@rakazo/contracts";
import { isDeletableMemoryDocument, isEmptyBotMemory } from "@rakazo/contracts";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import { Button, SectionHeading, Skeleton, Textarea } from "@rakazo/ui-web";
import { Tooltip, TooltipContent, TooltipTrigger } from "@rakazo/ui-web/components/ui/tooltip";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { downloadArtifactBytes } from "../../lib/pages/artifact-open";
import { useSave, useSpaceQueries } from "../../lib/query/query";

const NO_DOCS: MemoryDocument[] = [];

const fieldClass = "mt-2 w-full font-mono text-body-sm leading-relaxed";

/**
 * Bot memory. Skills belong to the person in a space, not to one bot, so they live in
 * the Skills dialog; memory shared across bots lives in the Memory settings overlay.
 */
export function KnowledgeSection({ botId }: { botId: string }) {
  return (
    <MemoryDocumentList
      key={botId}
      input={{ botId, scope: "bot" }}
      testId="bot-knowledge-memory"
      compact
    />
  );
}

/** The space's shared memory documents, mounted in the Memory settings overlay. */
export function SpaceMemorySection() {
  return (
    <section
      className="rounded-xl border border-border px-4 py-4"
      data-testid="space-memory-documents"
    >
      <SectionHeading variant="heading">
        <Trans>Shared memory</Trans>
      </SectionHeading>
      <p className="mt-1 text-body-sm text-muted-foreground">
        <Trans>Every bot in this space reads these notes and keeps them up to date.</Trans>
      </p>
      <div className="mt-3">
        <MemoryDocumentList input={{ scope: "user" }} testId="space-memory-list" />
      </div>
    </section>
  );
}

type MemoryChange = { kind: "save" | "remove" | "download"; doc: MemoryDocument };

function isConflict(error: unknown): boolean {
  return error instanceof ORPCError && error.code === "CONFLICT";
}

function MemoryDocumentList({
  input,
  testId,
  compact = false,
}: {
  input: { botId?: string; scope: "bot" | "user" };
  testId: string;
  compact?: boolean;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const list = queries.memory.list.queryOptions({ input });
  // Bots write memory as they run, so every open refreshes behind the cached list.
  const listQuery = useQuery({ ...list, refetchOnMount: "always" });
  const docs = listQuery.data ?? NO_DOCS;
  const loading = listQuery.isPending;
  const budgetInput = input.scope === "bot" && input.botId ? { botId: input.botId } : null;
  const budgetOptions = budgetInput
    ? queries.memory.budget.queryOptions({ input: budgetInput })
    : null;
  const budgetQuery = useQuery(
    budgetOptions ?? { queryKey: ["memory-budget", "none"], queryFn: skipToken },
  );
  const budget = budgetInput && budgetQuery.data ? budgetQuery.data : null;
  const bytesLeftOut = budget
    ? budget.omitted.reduce((sum, entry) => sum + entry.totalBytes, 0) +
      budget.documents.reduce((sum, entry) => sum + entry.totalBytes - entry.includedBytes, 0)
    : 0;
  const kb = Math.ceil(bytesLeftOut / 1024);
  const [showAll, setShowAll] = useState(false);
  // Once shown, memory stays visible while the panel is open, even if emptied.
  const [memoryShown, setMemoryShown] = useState(false);
  const memoryVisible = memoryShown || docs.some((doc) => !isEmptyBotMemory(doc));
  if (memoryVisible && !memoryShown) setMemoryShown(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loadedRevision, setLoadedRevision] = useState<number | undefined>();
  const [conflicted, setConflicted] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const change = useSave({
    save: async ({ kind, doc }: MemoryChange, rpc) => {
      if (kind === "download") {
        const latest = (await fetchFresh(queryClient, list)).find((entry) => entry.id === doc.id);
        if (!latest) throw new Error("Document unavailable");
        downloadArtifactBytes(
          latest.path.split("/").at(-1) ?? latest.path,
          "text/markdown",
          new TextEncoder().encode(latest.content),
        );
        return;
      }
      if (kind === "remove") {
        await rpc.memory.remove({ documentId: doc.id });
        await setDocs((current) => current.filter((entry) => entry.id !== doc.id));
        return;
      }
      const updated = await rpc.memory.update({
        documentId: doc.id,
        content: draft,
        expectedRevision: loadedRevision,
      });
      await setDocs((current) =>
        current.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
    },
    stale: ({ kind }) =>
      kind === "download"
        ? []
        : [list.queryKey, ...(budgetOptions ? [budgetOptions.queryKey] : [])],
    onSaved: (_saved, { kind }) => {
      if (kind !== "download") closeDoc();
    },
    onFailed: async (failure, { kind }) => {
      if (kind !== "save" || !isConflict(failure)) return;
      setConflicted(true);
      try {
        await fetchFresh(queryClient, list);
      } catch {
        // Keep the draft and conflict state even if refreshing fails.
      }
    },
  });
  const busy = change.pending;
  const actionError =
    change.error && !(change.input?.kind === "save" && isConflict(change.error))
      ? change.input?.kind === "remove"
        ? t`Could not remove`
        : change.input?.kind === "save"
          ? t`Could not save`
          : t`Could not load`
      : null;
  const error = actionError ?? (listQuery.isError ? t`Could not load` : null);

  /** What the save confirmed shows at once, even when the list cannot be read again. */
  function setDocs(update: (current: MemoryDocument[]) => MemoryDocument[]) {
    return writeSaved(queryClient, list.queryKey, (current) => update(current ?? []));
  }

  function openDoc(doc: MemoryDocument) {
    setLoadedRevision(doc.revision);
    setConflicted(false);
    setOpenId(doc.id);
    setDraft(doc.content);
    change.reset();
    setConfirmingDelete(false);
  }

  function closeDoc() {
    setOpenId(null);
    setConflicted(false);
    setConfirmingDelete(false);
  }

  function remove(doc: MemoryDocument) {
    if (confirmingDelete) change.run({ kind: "remove", doc });
    else setConfirmingDelete(true);
  }

  if (compact && !memoryVisible && !error) return null;
  return (
    <section className={compact ? "mt-6" : undefined}>
      {compact ? (
        <SectionHeading variant="label" className="mb-2">
          <Trans>Memory</Trans>
        </SectionHeading>
      ) : null}
      <div data-testid={testId} className={compact ? "rounded-xl bg-muted/50 p-4" : undefined}>
        {error ? <div className="pb-2 text-body-sm text-destructive">{error}</div> : null}
        {kb > 0 ? (
          <p className="pb-2 text-body-sm text-muted-foreground" data-testid="memory-budget-note">
            {t`About ${kb} KB of memory no longer reaches the bot.`}
          </p>
        ) : null}
        {conflicted ? (
          <div className="pb-2 text-body-sm text-destructive">
            <Trans>Document changed. Reopen to edit the latest version.</Trans>
          </div>
        ) : null}
        {loading ? <Skeleton className="h-10 w-full" /> : null}
        {!compact && !loading && docs.length === 0 && !error ? (
          <div className="py-1 text-body-sm text-muted-foreground">
            <Trans>Nothing remembered yet</Trans>
          </div>
        ) : null}
        <div>
          {(compact && !showAll ? docs.slice(0, 5) : docs).map((doc) => (
            <div key={doc.id} className="border-b border-border last:border-0">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => (openId === doc.id ? closeDoc() : openDoc(doc))}
                  className="-ms-2 h-auto min-w-0 flex-1 justify-start whitespace-normal px-2 py-2.5 text-start"
                >
                  <span
                    className="min-w-0 truncate text-body font-normal text-foreground"
                    dir="auto"
                  >
                    {doc.path}
                  </span>
                </Button>
                <Tooltip>
                  <TooltipTrigger
                    render={<Button variant="ghost" size="icon-sm" />}
                    aria-label={t`Download`}
                    disabled={busy}
                    onClick={() => change.run({ kind: "download", doc })}
                  >
                    <Download className="size-4" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <Trans>Download</Trans>
                  </TooltipContent>
                </Tooltip>
              </div>
              {openId === doc.id ? (
                <div className="pb-2">
                  <Textarea
                    aria-label={doc.path}
                    disabled={busy}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    rows={Math.min(16, Math.max(4, draft.split("\n").length + 1))}
                    className={fieldClass}
                    dir="auto"
                  />
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      disabled={busy || conflicted || draft === doc.content}
                      onClick={() => change.run({ kind: "save", doc })}
                    >
                      <Trans>Save</Trans>
                    </Button>
                    <Button
                      variant="ghost"
                      type="button"
                      disabled={busy}
                      onClick={closeDoc}
                      size="sm"
                    >
                      <Trans>Cancel</Trans>
                    </Button>
                    {isDeletableMemoryDocument(doc.path) ? (
                      <Button
                        variant="ghost"
                        type="button"
                        disabled={busy}
                        onClick={() => remove(doc)}
                        size="sm"
                        className="ml-auto text-destructive"
                      >
                        {confirmingDelete ? <Trans>Confirm delete</Trans> : <Trans>Delete</Trans>}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
        {compact && docs.length > 5 && !showAll ? (
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            onClick={() => setShowAll(true)}
          >
            <Trans>Show more</Trans>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
