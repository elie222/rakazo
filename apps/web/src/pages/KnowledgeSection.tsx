import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { AgentSkill, AgentSkillCatalogEntry, MemoryDocument } from "@rakazo/contracts";
import { isDeletableMemoryDocument, isEmptyBotMemory } from "@rakazo/contracts";
import { Badge, Button, Skeleton, Textarea } from "@rakazo/ui-web";
import { Tooltip, TooltipContent, TooltipTrigger } from "@rakazo/ui-web/components/ui/tooltip";
import { Download, Plus } from "lucide-react";
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

  async function save(doc: MemoryDocument) {
    if (busy || conflicted) return;
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
