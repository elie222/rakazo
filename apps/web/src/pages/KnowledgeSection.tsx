import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentSkill, AgentSkillCatalogEntry, MemoryDocument } from "@rakazo/contracts";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@rakazo/ui-web";
import { BookOpen, Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { downloadArtifactBytes } from "../lib/artifact-open";
import { rpc } from "../lib/rpc";

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
}: {
  botId: string;
  onSkillsChange: (skills: AgentSkillCatalogEntry[]) => void;
}) {
  const { t } = useLingui();
  return (
    <section className="mt-6" data-testid="bot-knowledge">
      <Tabs defaultValue="memory">
        <TabsList aria-label={t`Knowledge`}>
          <TabsTrigger value="memory">
            <Trans>Memory</Trans>
          </TabsTrigger>
          <TabsTrigger value="skills">
            <Trans>Shared skills</Trans>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="memory">
          <MemoryDocumentList
            key={botId}
            load={() => rpc.memory.list({ botId, scope: "bot" })}
            exportFilename="memory.md"
            testId="bot-knowledge-memory"
          />
        </TabsContent>
        <TabsContent value="skills">
          <AgentSkills onSkillsChange={onSkillsChange} />
        </TabsContent>
      </Tabs>
    </section>
  );
}

/** The space's shared memory documents, mounted in the Memory settings overlay. */
export function SpaceMemorySection() {
  return (
    <div className="mt-6" data-testid="space-memory-documents">
      <div className="mb-2 text-[12.5px] uppercase tracking-[0.08em] text-muted-foreground">
        <Trans>Shared documents</Trans>
      </div>
      <MemoryDocumentList
        load={() => rpc.memory.list({ scope: "user" })}
        exportFilename="space-memory.md"
        testId="space-memory-list"
      />
    </div>
  );
}

function MemoryDocumentList({
  load,
  exportFilename,
  testId,
}: {
  load: () => Promise<MemoryDocument[]>;
  exportFilename: string;
  testId: string;
}) {
  const { t } = useLingui();
  const [loading, setLoading] = useState(true);
  const [docs, setDocs] = useState<MemoryDocument[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [expandedDoc, setExpandedDoc] = useState<MemoryDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setOpenId(doc.id);
    setDraft(doc.content);
    setError(null);
  }

  async function save(doc: MemoryDocument): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const updated = await rpc.memory.update({ documentId: doc.id, content: draft });
      setDocs((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setOpenId(null);
      return true;
    } catch {
      setError(t`Could not save`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function exportMarkdown() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Re-fetch through the section's own loader so the file is current,
      // then sync the list so the export matches what is displayed.
      const fresh = await loadRef.current();
      generation.current += 1;
      setDocs(fresh);
      const markdown = fresh.map((doc) => `# ${doc.path}\n\n${doc.content}`).join("\n\n");
      downloadArtifactBytes(exportFilename, "text/markdown", new TextEncoder().encode(markdown));
    } catch {
      setError(t`Could not load`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid={testId}>
      {error ? <div className="px-2.5 pb-2 text-[13px] text-destructive">{error}</div> : null}
      {loading ? <Skeleton className="h-10 w-full" /> : null}
      {!loading && docs.length === 0 && !error ? (
        <div className="px-2.5 py-1 text-[13.5px] text-muted-foreground">
          <Trans>Nothing remembered yet</Trans>
        </div>
      ) : null}
      {docs.map((doc) => (
        <div key={doc.id}>
          <Button
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={() => (openId === doc.id ? setOpenId(null) : openDoc(doc))}
            className={rowClass(openId === doc.id)}
          >
            <span className="flex w-full items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-[14px] text-foreground" dir="auto">
                {doc.path}
              </span>
              <span className="shrink-0 text-[12px] text-muted-foreground">
                <Trans>rev {doc.revision}</Trans>
              </span>
            </span>
          </Button>
          {openId === doc.id ? (
            <div className="px-2.5 pb-2">
              <div className="relative mt-2 overflow-hidden rounded-lg border border-input bg-background/50">
                <div className="flex items-center justify-between border-b border-border/40 bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
                  <span className="font-mono">
                    {t`${draft.split("\n").length} lines · ${draft.length} chars`}
                  </span>
                  <button
                    type="button"
                    onClick={() => setExpandedDoc(doc)}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground/80 hover:bg-accent hover:text-foreground"
                    title={t`Expand to Fullscreen Editor`}
                  >
                    <Maximize2 className="h-3 w-3" />
                    <span><Trans>Expand</Trans></span>
                  </button>
                </div>
                <Textarea
                  aria-label={doc.path}
                  disabled={busy}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  style={{ fieldSizing: "fixed" }}
                  className="h-[260px] w-full resize-none overflow-y-auto bg-transparent p-2.5 font-mono text-[12.5px] leading-relaxed outline-none select-text border-0 shadow-none focus-visible:ring-0"
                  dir="auto"
                />
              </div>
              <div className="mt-2 flex items-center justify-between">
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={busy || draft === doc.content}
                    onClick={() => void save(doc)}
                    className="rounded-lg bg-muted px-3 py-1.5 text-[13px] text-foreground disabled:opacity-50"
                  >
                    <Trans>Save</Trans>
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => setOpenId(null)}
                    className="rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground"
                  >
                    <Trans>Cancel</Trans>
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => setExpandedDoc(doc)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  <Maximize2 className="mr-1 h-3 w-3" />
                  <Trans>Full Editor</Trans>
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
      {docs.length ? (
        <Button
          variant="ghost"
          type="button"
          disabled={busy}
          onClick={() => void exportMarkdown()}
          className="mt-2 px-2.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <Trans>Download as markdown</Trans>
        </Button>
      ) : null}

      {/* Expanded Fullscreen Memory Editor Dialog */}
      {expandedDoc ? (
        <Dialog open={Boolean(expandedDoc)} onOpenChange={() => setExpandedDoc(null)}>
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
                  Persistent memory documents guide the bot&apos;s behavior across all chat sessions in this space.
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
    </div>
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
              className={`${rowClass(false)} block`}
            >
              <span className="flex w-full items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[14px] text-foreground" dir="auto">
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
              <div className="min-w-0 truncate text-[14px] text-foreground" dir="auto">
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
          className="mt-2 px-2.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <Trans>New skill</Trans>
        </Button>
      )}
    </div>
  );
}
