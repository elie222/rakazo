import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentSkill, AgentSkillCatalogEntry, MemoryDocument } from "@rakazo/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";

const fieldClass =
  "mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 font-mono text-[13px] leading-relaxed text-[#ECECEE]";

function rowClass(open: boolean): string {
  return `w-full rounded-[11px] px-2.5 py-2.5 text-start ${open ? "bg-[#121214]" : "hover:bg-[#121214]"}`;
}

/**
 * What the agent knows, editable: its own memory document and the space's
 * agent skills. Space-wide memory lives in the Memory settings overlay.
 * Rides entirely on the existing memory.* and agentSkills.* RPCs.
 */
export function KnowledgeSection({ botId }: { botId: string }) {
  const [tab, setTab] = useState<"memory" | "skills">("memory");
  return (
    <div className="mt-6" data-testid="bot-knowledge">
      <div className="mb-3 flex items-center gap-2 text-[14px]">
        {(
          [
            { value: "memory" as const, label: <Trans>Memory</Trans> },
            { value: "skills" as const, label: <Trans>Skills</Trans> },
          ] satisfies Array<{ value: "memory" | "skills"; label: ReactNode }>
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={tab === option.value}
            onClick={() => setTab(option.value)}
            className={`rounded-lg px-2.5 py-1 ${
              tab === option.value ? "bg-[#1B1B1E] text-[#ECECEE]" : "text-[#85858A]"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {tab === "memory" ? (
        <MemoryDocumentList
          load={() => rpc.memory.list({ botId, scope: "bot" })}
          exportDownload={{ request: { botId }, filename: "memory.md" }}
          emptyLabel={<Trans>Nothing remembered yet</Trans>}
          testId="bot-knowledge-memory"
        />
      ) : (
        <AgentSkills />
      )}
    </div>
  );
}

/** The space's shared memory documents, mounted in the Memory settings overlay. */
export function SpaceMemorySection() {
  return (
    <div className="mt-6" data-testid="space-memory-documents">
      <div className="mb-2 text-[12.5px] uppercase tracking-[0.08em] text-[#6C6C70]">
        <Trans>Shared documents</Trans>
      </div>
      <MemoryDocumentList
        load={() => rpc.memory.list({ scope: "user" })}
        exportDownload={{ request: {}, filename: "space-memory.md" }}
        emptyLabel={<Trans>Nothing remembered yet</Trans>}
        testId="space-memory-list"
      />
    </div>
  );
}

function MemoryDocumentList({
  load,
  exportDownload,
  emptyLabel,
  testId,
}: {
  load: () => Promise<MemoryDocument[]>;
  exportDownload: { request: { botId?: string }; filename: string };
  emptyLabel: ReactNode;
  testId: string;
}) {
  const { t } = useLingui();
  const [docs, setDocs] = useState<MemoryDocument[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
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
      })
      .catch(() => {
        if (current !== generation.current) return;
        setDocs([]);
      });
    return () => {
      generation.current += 1;
    };
  }, []);

  function openDoc(doc: MemoryDocument) {
    setOpenId(doc.id);
    setDraft(doc.content);
    setError(null);
  }

  async function save(doc: MemoryDocument) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await rpc.memory.update({ documentId: doc.id, content: draft });
      setDocs((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setOpenId(null);
    } catch {
      setError(t`Could not save`);
    } finally {
      setBusy(false);
    }
  }

  async function exportMarkdown() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const markdown = await rpc.memory.exportMarkdown(exportDownload.request);
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = exportDownload.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(t`Could not export`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid={testId}>
      {error ? <div className="px-2.5 pb-2 text-[13px] text-[#E65707]">{error}</div> : null}
      {docs.length === 0 && !error ? (
        <div className="px-2.5 py-1 text-[13.5px] text-[#6C6C70]">{emptyLabel}</div>
      ) : null}
      {docs.map((doc) => (
        <div key={doc.id}>
          <button
            type="button"
            onClick={() => (openId === doc.id ? setOpenId(null) : openDoc(doc))}
            className={rowClass(openId === doc.id)}
          >
            <span className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-[14px] text-[#ECECEE]" dir="auto">
                {doc.path}
              </span>
              <span className="shrink-0 text-[12px] text-[#6C6C70]">
                <Trans>rev {doc.revision}</Trans>
              </span>
            </span>
          </button>
          {openId === doc.id ? (
            <div className="px-2.5 pb-2">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={Math.min(16, Math.max(4, draft.split("\n").length + 1))}
                className={fieldClass}
                dir="auto"
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy || draft === doc.content}
                  onClick={() => void save(doc)}
                  className="rounded-lg bg-[#1B1B1E] px-3 py-1.5 text-[13px] text-[#ECECEE] disabled:opacity-50"
                >
                  <Trans>Save</Trans>
                </button>
                <button
                  type="button"
                  onClick={() => setOpenId(null)}
                  className="rounded-lg px-3 py-1.5 text-[13px] text-[#85858A]"
                >
                  <Trans>Cancel</Trans>
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
      {docs.length ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void exportMarkdown()}
          className="mt-2 px-2.5 text-[13px] text-[#7A7A80] hover:text-[#C9C9CE]"
        >
          <Trans>Download as markdown</Trans>
        </button>
      ) : null}
    </div>
  );
}

const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when the agent should use it.
---

Steps the agent should follow.
`;

function AgentSkills() {
  const { t } = useLingui();
  const [skills, setSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [open, setOpen] = useState<AgentSkill | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  async function refresh() {
    const current = ++generation.current;
    const list = await rpc.agentSkills.list();
    if (current !== generation.current) return;
    setSkills(list);
  }

  useEffect(() => {
    const current = ++generation.current;
    void rpc.agentSkills
      .list()
      .then((list) => {
        if (current !== generation.current) return;
        setSkills(list);
      })
      .catch(() => {
        if (current !== generation.current) return;
        setSkills([]);
      });
    return () => {
      generation.current += 1;
    };
  }, []);

  async function openSkill(entry: AgentSkillCatalogEntry) {
    if (busy) return;
    setCreating(false);
    setError(null);
    try {
      const skill = await rpc.agentSkills.get({ skillId: entry.id });
      setOpen(skill);
      setDraft(skill.content);
    } catch {
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
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save skill`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(skill: AgentSkill) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.agentSkills.remove({ skillId: skill.id });
      setOpen(null);
      await refresh();
    } catch {
      setError(t`Could not delete skill`);
    } finally {
      setBusy(false);
    }
  }

  const editorOpen = creating || open;
  return (
    <div data-testid="bot-knowledge-skills">
      {error ? <div className="px-2.5 pb-2 text-[13px] text-[#E65707]">{error}</div> : null}
      {skills.length === 0 && !editorOpen && !error ? (
        <div className="px-2.5 py-1 text-[13.5px] text-[#6C6C70]">
          <Trans>No skills yet</Trans>
        </div>
      ) : null}
      {!editorOpen
        ? skills.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => void openSkill(entry)}
              className={rowClass(false)}
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-[14px] text-[#ECECEE]" dir="auto">
                  {entry.name}
                </span>
                {entry.readOnly ? (
                  <span className="shrink-0 text-[12px] text-[#6C6C70]">
                    <Trans>read-only</Trans>
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block truncate text-[12.5px] text-[#6C6C70]" dir="auto">
                {entry.description}
              </span>
            </button>
          ))
        : null}
      {editorOpen ? (
        <div className="px-2.5 pb-2">
          {open ? (
            <div className="pb-1 text-[14px] text-[#ECECEE]" dir="auto">
              {open.name}
            </div>
          ) : null}
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={Math.min(20, Math.max(8, draft.split("\n").length + 1))}
            readOnly={Boolean(open?.readOnly)}
            className={fieldClass}
            dir="auto"
          />
          <div className="mt-2 flex items-center gap-2">
            {!open?.readOnly ? (
              <button
                type="button"
                disabled={busy || !draft.trim() || (!creating && draft === open?.content)}
                onClick={() => void save()}
                className="rounded-lg bg-[#1B1B1E] px-3 py-1.5 text-[13px] text-[#ECECEE] disabled:opacity-50"
              >
                <Trans>Save</Trans>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setOpen(null);
                setCreating(false);
              }}
              className="rounded-lg px-3 py-1.5 text-[13px] text-[#85858A]"
            >
              {open?.readOnly ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
            </button>
            {open && !open.readOnly ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(open)}
                className="ms-auto rounded-lg px-3 py-1.5 text-[13px] text-[#E65707]"
              >
                <Trans>Delete</Trans>
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(null);
            setCreating(true);
            setDraft(NEW_SKILL_TEMPLATE);
            setError(null);
          }}
          className="mt-2 px-2.5 text-[13px] text-[#7A7A80] hover:text-[#C9C9CE]"
        >
          <Trans>New skill</Trans>
        </button>
      )}
    </div>
  );
}
