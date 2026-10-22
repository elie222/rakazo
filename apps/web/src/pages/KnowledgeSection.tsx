import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { AgentSkill, AgentSkillCatalogEntry, MemoryDocument } from "@rakazo/contracts";
import { isDeletableMemoryDocument, isEmptyBotMemory } from "@rakazo/contracts";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Skeleton,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@rakazo/ui-web";
import { BookOpen, Download, Maximize2, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SettingsSectionHeading } from "../components/SettingsSectionHeading";
import { downloadArtifactBytes } from "../lib/artifact-open";
import { useSpaceRpc } from "../lib/space-rpc";

const fieldClass = "mt-2 w-full font-mono text-[13px] leading-relaxed";

function rowClass(open: boolean): string {
  return `h-auto w-full justify-start whitespace-normal px-2.5 py-2.5 text-start ${open ? "bg-muted" : ""}`;
}

/**
 * Bot memory and the current user's skills in this space.
 * User-scoped memory shared across bots lives in the Memory settings overlay.
 */
export function KnowledgeSection({
  botId,
  onSkillsChange,
  skillsOnly = false,
}: {
  botId: string;
  onSkillsChange: (skills: AgentSkillCatalogEntry[]) => void;
  skillsOnly?: boolean;
}) {
  const rpc = useSpaceRpc();
  if (skillsOnly)
    return (
      <section data-testid="bot-knowledge">
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          <Trans>Skills</Trans>
        </h3>
        <div className="rounded-xl bg-muted/50 p-4">
          <AgentSkills onSkillsChange={onSkillsChange} />
        </div>
      </section>
    );
  return (
    <MemoryDocumentList
      key={botId}
      load={() => rpc.memory.list({ botId, scope: "bot" })}
      testId="bot-knowledge-memory"
      compact
    />
  );
}

/** The space's shared memory documents, mounted in the Memory settings overlay. */
export function SpaceMemorySection() {
  const rpc = useSpaceRpc();
  return (
    <section
      className="rounded-xl border border-border px-4 py-4"
      data-testid="space-memory-documents"
    >
      <SettingsSectionHeading className="mb-0">
        <Trans>Shared documents</Trans>
      </SettingsSectionHeading>
      <div className="mt-3">
        <MemoryDocumentList
          load={() => rpc.memory.list({ scope: "user" })}
          testId="space-memory-list"
        />
      </div>
    </section>
  );
}

function MemoryDocumentList({
  load,
  testId,
  compact = false,
}: {
  load: () => Promise<MemoryDocument[]>;
  testId: string;
  compact?: boolean;
}) {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [docs, setDocs] = useState<MemoryDocument[]>([]);
  const [memoryVisible, setMemoryVisible] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [expandedDoc, setExpandedDoc] = useState<MemoryDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [loadedRevision, setLoadedRevision] = useState<number | undefined>();
  const [conflicted, setConflicted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const generation = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const current = ++generation.current;
    void loadRef
      .current()
      .then((list) => {
        if (current !== generation.current) return;
        setDocs(list);
        setMemoryVisible((visible) => visible || list.some((doc) => !isEmptyBotMemory(doc)));
        setLoading(false);
      })
      .catch(() => {
        if (current !== generation.current) return;
        setDocs([]);
        setLoading(false);
        setError(t`Could not load`);
      });
    return () => {
      generation.current += 1;
    };
  }, [t]);

  function openDoc(doc: MemoryDocument) {
    setLoadedRevision(doc.revision);
    setConflicted(false);
    setOpenId(doc.id);
    setDraft(doc.content);
    setError(null);
    setConfirmingDelete(false);
  }

  function closeDoc() {
    setOpenId(null);
    setConflicted(false);
    setConfirmingDelete(false);
  }

  async function remove(doc: MemoryDocument) {
    if (busy) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rpc.memory.remove({ documentId: doc.id });
      setDocs((current) => current.filter((entry) => entry.id !== doc.id));
      closeDoc();
    } catch {
      setError(t`Could not remove`);
    } finally {
      setBusy(false);
    }
  }

  async function save(doc: MemoryDocument): Promise<boolean> {
    if (busy || conflicted) return false;
    setBusy(true);
    setError(null);
    try {
      const updated = await rpc.memory.update({
        documentId: doc.id,
        content: draft,
        expectedRevision: loadedRevision,
      });
      setDocs((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      closeDoc();
      return true;
    } catch (err) {
      if (err instanceof ORPCError && err.code === "CONFLICT") {
        setConflicted(true);
        try {
          setDocs(await loadRef.current());
        } catch {
          // Keep the draft and conflict state even if refreshing fails.
        }
      } else {
        setError(t`Could not save`);
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function downloadDocument(doc: MemoryDocument) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const latest = (await loadRef.current()).find((entry) => entry.id === doc.id);
      if (!latest) throw new Error("Document unavailable");
      downloadArtifactBytes(
        latest.path.split("/").at(-1) ?? latest.path,
        "text/markdown",
        new TextEncoder().encode(latest.content),
      );
    } catch {
      setError(t`Could not load`);
    } finally {
      setBusy(false);
    }
  }

  if (compact && !memoryVisible && !error) return null;
  return (
    <section className={compact ? "mt-6" : undefined}>
      {compact ? (
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          <Trans>Memory</Trans>
        </h3>
      ) : null}
      <div data-testid={testId} className={compact ? "rounded-xl bg-muted/50 p-4" : undefined}>
        {error ? <div className="pb-2 text-[13px] text-destructive">{error}</div> : null}
        {conflicted ? (
          <div className="pb-2 text-[13px] text-destructive">
            <Trans>Document changed. Reopen to edit the latest version.</Trans>
          </div>
        ) : null}
        {loading ? <Skeleton className="h-10 w-full" /> : null}
        {!compact && !loading && docs.length === 0 && !error ? (
          <div className="py-1 text-[13px] text-muted-foreground">
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
                    className="min-w-0 truncate text-[14px] font-normal text-foreground"
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
                    onClick={() => downloadDocument(doc)}
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
                  <div className="relative mt-2 overflow-hidden rounded-lg border border-input bg-background/50">
                    <div className="flex items-center justify-between border-b border-border/40 bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
                      <span className="font-mono">
                        {t`${draft.split("\n").length} lines · ${draft.length} chars`}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={busy}
                        onClick={() => setExpandedDoc(doc)}
                        className="gap-1 text-muted-foreground"
                        title={t`Expand to Fullscreen Editor`}
                      >
                        <Maximize2 className="size-3" />
                        <span>
                          <Trans>Expand</Trans>
                        </span>
                      </Button>
                    </div>
                    <Textarea
                      aria-label={doc.path}
                      disabled={busy}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={Math.min(16, Math.max(4, draft.split("\n").length + 1))}
                      className={fieldClass}
                      dir="auto"
                    />
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      disabled={busy || conflicted || draft === doc.content}
                      onClick={() => void save(doc)}
                      className="rounded-full"
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
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      disabled={busy}
                      onClick={() => setExpandedDoc(doc)}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      <Maximize2 className="mr-1 h-3 w-3" />
                      <Trans>Full Editor</Trans>
                    </Button>
                    {isDeletableMemoryDocument(doc.path) ? (
                      <Button
                        variant="ghost"
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(doc)}
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

      {/* Expanded Fullscreen Memory Editor Dialog */}
      {expandedDoc ? (
        <Dialog
          open={Boolean(expandedDoc)}
          onOpenChange={(open) => {
            if (!open && !busy) setExpandedDoc(null);
          }}
        >
          <DialogContent className="flex h-[90vh] w-[95vw] max-w-5xl flex-col overflow-hidden p-6 sm:max-w-5xl">
            <DialogHeader className="shrink-0 pb-2">
              <DialogTitle className="flex items-center gap-2 text-xl font-semibold">
                <BookOpen className="h-5 w-5 text-primary" />
                <span>
                  {expandedDoc.path} ({t`rev ${expandedDoc.revision}`})
                </span>
              </DialogTitle>
            </DialogHeader>

            <div className="flex flex-1 min-h-0 flex-col space-y-3 pt-1">
              <p className="shrink-0 text-xs text-muted-foreground">
                <Trans>
                  Persistent memory documents guide the bot&apos;s behavior across all chat sessions
                  in this space.
                </Trans>
              </p>

              {error ? <div className="text-xs text-destructive">{error}</div> : null}

              <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-xl border border-border/80 bg-background/50 shadow-inner">
                <div className="flex shrink-0 items-center justify-between border-b border-border/40 bg-muted/30 px-3.5 py-1.5 text-[11px] text-muted-foreground">
                  <div className="flex items-center gap-2 font-mono">
                    <span className="font-semibold text-foreground/80">{expandedDoc.path}</span>
                    <span>•</span>
                    <span>{t`${draft.split("\n").length} lines`}</span>
                    <span>•</span>
                    <span>{t`${draft.length} chars`}</span>
                  </div>
                </div>

                <Textarea
                  aria-label={expandedDoc.path}
                  disabled={busy}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  spellCheck={false}
                  style={{ fieldSizing: "fixed" }}
                  className="h-full w-full flex-1 resize-none overflow-y-auto bg-transparent p-4 font-mono text-[13px] leading-relaxed outline-none select-text border-0 shadow-none focus-visible:ring-0"
                  dir="auto"
                />
              </div>

              <div className="flex shrink-0 items-center justify-end gap-2 pt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  disabled={busy}
                  onClick={() => setExpandedDoc(null)}
                >
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  type="button"
                  disabled={busy || draft === expandedDoc.content}
                  onClick={async () => {
                    const ok = await save(expandedDoc);
                    if (ok) {
                      setExpandedDoc(null);
                    }
                  }}
                >
                  <Trans>Save Memory</Trans>
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}

function SkillSourceBadge({ source }: { source: AgentSkillCatalogEntry["source"] }) {
  if (source !== "builtin" && source !== "plugin") return null;
  return (
    <Badge
      variant="secondary"
      className="rounded-full px-1.5 py-0 text-[11px] font-normal text-muted-foreground"
    >
      {source === "builtin" ? <Trans>Built-in</Trans> : <Trans>Plugin</Trans>}
    </Badge>
  );
}

const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when the agent should use it.
---

Steps the agent should follow.
`;

function AgentSkills({
  onSkillsChange,
}: {
  onSkillsChange: (skills: AgentSkillCatalogEntry[]) => void;
}) {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const [loading, setLoading] = useState(true);
  const [skills, setSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [open, setOpen] = useState<AgentSkill | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const generation = useRef(0);
  const selection = useRef(0);

  async function refresh() {
    const current = ++generation.current;
    const list = await rpc.agentSkills.list();
    if (current !== generation.current) return;
    setSkills(list);
    onSkillsChange(list);
  }

  useEffect(() => {
    const current = ++generation.current;
    void rpc.agentSkills
      .list()
      .then((list) => {
        if (current !== generation.current) return;
        setSkills(list);
        setLoading(false);
      })
      .catch(() => {
        if (current !== generation.current) return;
        setSkills([]);
        setLoading(false);
        setError(t`Could not load`);
      });
    return () => {
      generation.current += 1;
      selection.current += 1;
    };
  }, [t]);

  async function openSkill(entry: AgentSkillCatalogEntry) {
    if (busy) return;
    const current = ++selection.current;
    setCreating(false);
    setConfirmingDelete(false);
    setError(null);
    try {
      const skill = await rpc.agentSkills.get({ skillId: entry.id });
      // A slower response must not clobber a newer selection or a fresh draft.
      if (current !== selection.current) return;
      setOpen(skill);
      setDraft(skill.content);
    } catch {
      if (current !== selection.current) return;
      setError(t`Could not load skill`);
    }
  }

  async function save() {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        await rpc.agentSkills.create({ content: draft });
      } else if (open) {
        await rpc.agentSkills.update({ skillId: open.id, content: draft });
      }
      setOpen(null);
      setCreating(false);
      setConfirmingDelete(false);
      try {
        await refresh();
      } catch {
        setError(t`Could not load`);
      }
    } catch {
      setError(t`Could not save skill`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(skill: AgentSkill) {
    if (busy) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    const skillId = skill.id;
    setBusy(true);
    setError(null);
    try {
      await rpc.agentSkills.remove({ skillId });
      if (open?.id === skillId) {
        setOpen(null);
        setConfirmingDelete(false);
      }
      try {
        await refresh();
      } catch {
        setError(t`Could not load`);
      }
    } catch {
      setError(t`Could not delete skill`);
    } finally {
      setBusy(false);
    }
  }

  const editorOpen = creating || open;
  return (
    <div data-testid="bot-knowledge-skills">
      {error ? <div className="px-2.5 pb-2 text-[13px] text-destructive">{error}</div> : null}
      {loading ? <Skeleton className="h-10 w-full" /> : null}
      {!loading && skills.length === 0 && !editorOpen && !error ? (
        <div className="px-2.5 py-1 text-[13.5px] text-muted-foreground">
          <Trans>No skills yet</Trans>
        </div>
      ) : null}
      {!editorOpen
        ? skills.map((entry) => (
            <Button
              variant="ghost"
              key={entry.id}
              type="button"
              disabled={busy}
              onClick={() => void openSkill(entry)}
              className={`${rowClass(false)} -mx-2.5 w-[calc(100%+1.25rem)] block`}
            >
              <span className="flex w-full items-center justify-between gap-3">
                <span
                  className="min-w-0 truncate text-[14px] font-normal text-foreground"
                  dir="auto"
                >
                  {entry.name}
                </span>
                <SkillSourceBadge source={entry.source} />
              </span>
              <span
                className="mt-0.5 block truncate text-[12.5px] text-muted-foreground"
                dir="auto"
              >
                {entry.description}
              </span>
            </Button>
          ))
        : null}
      {editorOpen ? (
        <div className="px-2.5 pb-2">
          {open ? (
            <div className="flex items-center gap-2 pb-1">
              <div className="min-w-0 truncate text-[14px] font-normal text-foreground" dir="auto">
                {open.name}
              </div>
              <SkillSourceBadge source={open.source} />
            </div>
          ) : null}
          <Textarea
            aria-label="SKILL.md"
            disabled={busy}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={Math.min(20, Math.max(8, draft.split("\n").length + 1))}
            readOnly={Boolean(open?.readOnly)}
            className={fieldClass}
            dir="auto"
          />
          <div className="mt-2 flex items-center gap-2">
            {!open?.readOnly ? (
              <Button
                variant="ghost"
                type="button"
                disabled={busy || !draft.trim() || (!creating && draft === open?.content)}
                onClick={() => void save()}
                className="rounded-lg bg-muted px-3 py-1.5 text-[13px] text-foreground disabled:opacity-50"
              >
                <Trans>Save</Trans>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                selection.current += 1;
                setOpen(null);
                setCreating(false);
                setConfirmingDelete(false);
              }}
              className="rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground"
            >
              {open?.readOnly ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
            </Button>
            {open && !open.readOnly ? (
              <Button
                variant="ghost"
                type="button"
                disabled={busy}
                onClick={() => void remove(open)}
                className={`ms-auto rounded-lg px-3 py-1.5 text-[13px] ${
                  confirmingDelete ? "bg-destructive/10 text-destructive" : "text-destructive"
                }`}
              >
                {confirmingDelete ? <Trans>Confirm delete</Trans> : <Trans>Delete</Trans>}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          type="button"
          disabled={busy}
          onClick={() => {
            selection.current += 1;
            setOpen(null);
            setCreating(true);
            setConfirmingDelete(false);
            setDraft(NEW_SKILL_TEMPLATE);
            setError(null);
          }}
          className="-mx-2.5 mt-2 h-auto min-h-11 w-[calc(100%+1.25rem)] justify-between px-2.5 py-2.5 text-sm font-normal text-foreground"
        >
          <Trans>New skill</Trans>
          <Plus aria-hidden="true" className="size-4 text-muted-foreground" />
        </Button>
      )}
    </div>
  );
}
