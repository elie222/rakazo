import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { AgentSkill, AgentSkillCatalogEntry } from "@rakazo/contracts";
import { formatFileSize, parseSkillMd } from "@rakazo/core";
import { Badge, Button, Field, FieldLabel, Input, Skeleton, Textarea } from "@rakazo/ui-web";
import { skipToken, useQuery } from "@tanstack/react-query";
import { ChevronLeft, FileText, Folder, Plus } from "lucide-react";
import { useState } from "react";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import {
  AvailabilityControl,
  reachesOtherSpaces,
  useOwnSpaces,
} from "../integrations/space-availability";
import { isMarkdownPath, SKILL_DOCUMENT, skillFileRows } from "./skill-file-tree";

const NO_FILES: never[] = [];

type DocumentDraft = { kind: "document"; name: string; description: string; body: string };
type FileDraft = { kind: "file"; path: string; text: string };
type Draft = DocumentDraft | FileDraft;

const monoField = "w-full font-mono text-body-sm leading-relaxed";

export function SkillSourceBadge({ source }: { source: AgentSkillCatalogEntry["source"] }) {
  if (source !== "builtin" && source !== "plugin") return null;
  return (
    <Badge
      variant="secondary"
      className="rounded-full px-1.5 py-0 text-caption font-normal text-muted-foreground"
    >
      {source === "builtin" ? <Trans>Built-in</Trans> : <Trans>Plugin</Trans>}
    </Badge>
  );
}

/** The instructions of a SKILL.md without its frontmatter, or all of it when it has none. */
function documentParts(skill: AgentSkill): DocumentDraft {
  const parsed = parseSkillMd(skill.content);
  return {
    kind: "document",
    name: skill.name,
    description: skill.description,
    body: "error" in parsed ? skill.content : parsed.body,
  };
}

/**
 * One skill as a folder: its files beside the open file, read first and edited with Edit and
 * Save. With no `skillId` it starts a new skill, which can take files once it is saved.
 */
export function SkillPage({
  skillId,
  onBack,
  onCreated,
  onDeleted,
}: {
  skillId?: string;
  onBack: () => void;
  onCreated: (skillId: string) => void;
  onDeleted: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const spaceCount = useOwnSpaces().length;
  const creating = skillId === undefined;
  const skillQuery = useQuery(
    queries.agentSkills.get.queryOptions({ input: skillId ? { skillId } : skipToken }),
  );
  const skill = skillQuery.data;
  const canEdit = creating || skill?.readOnly === false;
  const filesQuery = useQuery(
    queries.agentSkills.listFiles.queryOptions({
      input: skillId && !skillId.startsWith("builtin:") ? { skillId } : skipToken,
    }),
  );
  const files = filesQuery.data ?? NO_FILES;
  const [path, setPath] = useState(SKILL_DOCUMENT);
  const fileQuery = useQuery(
    queries.agentSkills.getFile.queryOptions({
      input: skillId && path !== SKILL_DOCUMENT ? { skillId, path } : skipToken,
    }),
  );
  const [draft, setDraft] = useState<Draft | null>(
    creating ? { kind: "document", name: "", description: "", body: "" } : null,
  );
  const [baseline, setBaseline] = useState<Draft | null>(draft);
  const [adding, setAdding] = useState<{ path: string; text: string } | null>(null);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [armed, setArmed] = useState<"skill" | "file" | null>(null);
  const changed =
    (draft !== null && JSON.stringify(draft) !== JSON.stringify(baseline)) ||
    Boolean(adding && (adding.path.trim() || adding.text));
  const listKey = queries.agentSkills.list.queryKey();
  const skillKey = (id: string) => queries.agentSkills.get.queryKey({ input: { skillId: id } });
  const filesKey = (id: string) =>
    queries.agentSkills.listFiles.queryKey({ input: { skillId: id } });

  const failure = (error: Error | null) => {
    if (!error) return null;
    if (error instanceof ORPCError && (error.code === "BAD_REQUEST" || error.code === "CONFLICT"))
      return error.message;
    return t`Could not save`;
  };
  const stopEditing = () => {
    setDraft(null);
    setBaseline(null);
    setLeaving(null);
  };
  /** Leaving the open file asks first while it has changes that were not saved. */
  const leave = (go: () => void) => {
    if (changed) {
      setLeaving(() => go);
      return;
    }
    stopEditing();
    setAdding(null);
    setArmed(null);
    go();
  };

  const saveDocument = useSave({
    save: (next: DocumentDraft, rpc) => {
      const fields = {
        name: next.name.trim(),
        description: next.description.trim(),
        body: next.body,
      };
      return skillId
        ? rpc.agentSkills.update({ skillId, ...fields })
        : rpc.agentSkills.create(fields);
    },
    stale: () => (skillId ? [listKey, skillKey(skillId)] : [listKey]),
    onSaved: (saved) => {
      stopEditing();
      if (creating) onCreated(saved.id);
    },
  });
  const saveFile = useSave({
    save: (file: { path: string; content: string }, rpc) =>
      rpc.agentSkills.update({ skillId: skillId ?? "", file }),
    stale: (file) =>
      skillId
        ? [
            filesKey(skillId),
            queries.agentSkills.getFile.queryKey({ input: { skillId, path: file.path } }),
          ]
        : [],
    onSaved: (_saved, file) => {
      stopEditing();
      setAdding(null);
      setPath(file.path);
    },
  });
  const removeFile = useSave({
    save: (file: string, rpc) => rpc.agentSkills.removeFile({ skillId: skillId ?? "", path: file }),
    stale: () => (skillId ? [filesKey(skillId)] : []),
    onSaved: () => {
      stopEditing();
      setArmed(null);
      setPath(SKILL_DOCUMENT);
    },
  });
  const removeSkill = useSave({
    save: (id: string, rpc) => rpc.agentSkills.remove({ skillId: id }),
    stale: [listKey],
    onSaved: onDeleted,
    closesScreen: true,
  });
  const busy =
    saveDocument.pending || saveFile.pending || removeFile.pending || removeSkill.pending;
  const error =
    failure(saveDocument.error) ??
    failure(saveFile.error) ??
    failure(removeFile.error) ??
    failure(removeSkill.error);

  if (!creating && !skill) {
    return (
      <div className="space-y-3">
        <BackButton onBack={onBack} />
        {skillQuery.isError ? (
          <p className="text-body text-destructive">
            <Trans>Could not load skill</Trans>
          </p>
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </div>
    );
  }

  const edit = () => {
    if (!skill) return;
    const next: Draft =
      path === SKILL_DOCUMENT
        ? documentParts(skill)
        : { kind: "file", path, text: fileQuery.data?.content ?? "" };
    setDraft(next);
    setBaseline(next);
    setArmed(null);
  };
  const save = () => {
    if (!draft || busy) return;
    if (draft.kind === "document") saveDocument.run(draft);
    else saveFile.run({ path: draft.path, content: draft.text });
  };

  const open = (next: string) => leave(() => setPath(next));
  const rows = skillFileRows(files);

  return (
    <div data-testid="skill-page" className="space-y-4">
      <BackButton onBack={() => leave(onBack)} />
      {skill ? (
        <div className="space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-heading3 font-medium text-foreground" dir="auto">
              {skill.name}
            </h3>
            <SkillSourceBadge source={skill.source} />
          </div>
          <p className="text-body-sm text-muted-foreground" dir="auto">
            {skill.description}
          </p>
          {skill.source === "user" ? (
            <AvailabilityControl
              kind="skill"
              id={skill.id}
              availability={skill.availability}
              onChanged={async () => {
                const here = await skillQuery.refetch();
                if (here.isError) onBack();
              }}
            />
          ) : null}
        </div>
      ) : null}
      {leaving ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-xl bg-background px-3 py-2 text-body-sm"
        >
          <span className="min-w-0 flex-1">
            <Trans>Your changes are not saved.</Trans>
          </span>
          <Button variant="ghost" size="sm" onClick={() => setLeaving(null)}>
            <Trans>Keep editing</Trans>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => {
              const go = leaving;
              stopEditing();
              setAdding(null);
              go();
            }}
          >
            <Trans>Discard</Trans>
          </Button>
        </div>
      ) : null}
      <div className={creating ? "" : "grid gap-3 sm:grid-cols-[14rem_minmax(0,1fr)]"}>
        {creating ? null : (
          <nav aria-label={t`Files`} className="self-start sm:sticky sm:top-0">
            {rows.map((row) =>
              row.kind === "folder" ? (
                <div
                  key={row.key}
                  className="flex min-h-8 items-center gap-2.5 px-2.5 text-body-sm text-muted-foreground"
                  style={{ paddingInlineStart: `${0.625 + row.depth}rem` }}
                >
                  <Folder aria-hidden="true" className="size-4 shrink-0" />
                  <span className="truncate" dir="auto">
                    {row.name}
                  </span>
                </div>
              ) : (
                <Button
                  key={row.key}
                  variant="ghost"
                  type="button"
                  aria-current={!adding && row.path === path ? "true" : undefined}
                  // Held while a save refreshes, so its result never pulls the page back.
                  disabled={busy}
                  onClick={() => open(row.path)}
                  className="h-auto min-h-8 w-full justify-start gap-2.5 px-2.5 py-1.5 text-body-sm font-normal aria-[current=true]:bg-dialog"
                  style={{ paddingInlineStart: `${0.625 + row.depth}rem` }}
                >
                  <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-start" dir="auto">
                    {row.name}
                  </span>
                  {changed && draft?.kind === "file" && draft.path === row.path ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-foreground">
                      <span className="sr-only">
                        <Trans>Unsaved changes</Trans>
                      </span>
                    </span>
                  ) : changed && draft?.kind === "document" && row.path === SKILL_DOCUMENT ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-foreground">
                      <span className="sr-only">
                        <Trans>Unsaved changes</Trans>
                      </span>
                    </span>
                  ) : row.bytes !== undefined ? (
                    <span className="shrink-0 text-caption text-muted-foreground tabular-nums">
                      {formatFileSize(row.bytes)}
                    </span>
                  ) : null}
                </Button>
              ),
            )}
            {canEdit && adding ? (
              <div className="flex min-h-8 items-center gap-2.5 rounded-lg bg-dialog px-2.5 py-1">
                <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <input
                  id="skill-file-path"
                  aria-label={t`New file path`}
                  value={adding.path}
                  onChange={(event) => setAdding({ ...adding, path: event.target.value })}
                  placeholder="references/notes.md"
                  maxLength={240}
                  disabled={busy}
                  // biome-ignore lint/a11y/noAutofocus: the row appears because the person asked for a new file.
                  autoFocus
                  className="min-w-0 flex-1 bg-transparent text-body-sm outline-none placeholder:text-muted-foreground"
                  dir="auto"
                />
              </div>
            ) : canEdit ? (
              <Button
                variant="ghost"
                type="button"
                disabled={busy}
                onClick={() => leave(() => setAdding({ path: "", text: "" }))}
                className="h-auto min-h-8 w-full justify-start gap-2.5 px-2.5 py-1.5 text-body-sm font-normal text-muted-foreground"
              >
                <Plus aria-hidden="true" className="size-4 shrink-0" />
                <Trans>Add file</Trans>
              </Button>
            ) : null}
          </nav>
        )}
        <section
          aria-label={adding ? t`Add file` : creating ? t`New skill` : path}
          className="min-w-0 rounded-2xl bg-dialog"
        >
          {adding ? (
            <div className="space-y-3 p-5">
              <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
                <span
                  className={`text-body-sm font-medium ${adding.path.trim() ? "" : "text-muted-foreground"}`}
                  dir="auto"
                >
                  {adding.path.trim() || t`New file`}
                </span>
                <span className="flex-1" />
                <Button
                  size="sm"
                  disabled={busy || !adding.path.trim()}
                  onClick={() => saveFile.run({ path: adding.path.trim(), content: adding.text })}
                >
                  <Trans>Save</Trans>
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAdding(null)}>
                  <Trans>Cancel</Trans>
                </Button>
              </div>
              {error ? <p className="text-body-sm text-destructive">{error}</p> : null}
              <TextEditor
                id="skill-file-text"
                label={t`File text`}
                value={adding.text}
                onChange={(text) => setAdding({ ...adding, text })}
                markdown={isMarkdownPath(adding.path.trim())}
                disabled={busy}
              />
            </div>
          ) : (
            <div className="space-y-3 p-5">
              <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
                {creating ? null : (
                  <span className="text-body-sm font-medium" dir="auto">
                    {path}
                  </span>
                )}
                <span className="flex-1" />
                {canEdit && draft ? (
                  <>
                    <Button size="sm" disabled={busy || !changed} onClick={save}>
                      <Trans>Save</Trans>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={creating ? onBack : stopEditing}
                    >
                      <Trans>Cancel</Trans>
                    </Button>
                  </>
                ) : canEdit ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || (path !== SKILL_DOCUMENT && !fileQuery.data)}
                    onClick={edit}
                  >
                    <Trans>Edit</Trans>
                  </Button>
                ) : null}
              </div>
              {error && draft ? <p className="text-body-sm text-destructive">{error}</p> : null}
              {draft?.kind === "document" ? (
                <>
                  <DocumentEditor draft={draft} onChange={setDraft} disabled={busy} />
                  {skill && canEdit ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (armed !== "skill") return setArmed("skill");
                        removeSkill.run(skill.id);
                      }}
                      className={`-ms-2 text-destructive ${armed === "skill" ? "bg-destructive/10" : ""}`}
                    >
                      {armed !== "skill" ? (
                        <Trans>Delete skill</Trans>
                      ) : reachesOtherSpaces(skill.availability, spaceCount) ? (
                        <Trans>Remove from every space?</Trans>
                      ) : (
                        <Trans>Confirm delete</Trans>
                      )}
                    </Button>
                  ) : null}
                </>
              ) : draft?.kind === "file" ? (
                <>
                  <TextEditor
                    label={draft.path}
                    value={draft.text}
                    onChange={(text) => setDraft({ ...draft, text })}
                    markdown={isMarkdownPath(draft.path)}
                    disabled={busy}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      if (armed !== "file") return setArmed("file");
                      removeFile.run(draft.path);
                    }}
                    className={`-ms-2 text-destructive ${armed === "file" ? "bg-destructive/10" : ""}`}
                  >
                    {armed === "file" ? (
                      <Trans>Delete this file?</Trans>
                    ) : (
                      <Trans>Delete file</Trans>
                    )}
                  </Button>
                </>
              ) : path === SKILL_DOCUMENT && skill ? (
                <FileContent text={documentParts(skill).body} markdown />
              ) : fileQuery.data ? (
                <FileContent text={fileQuery.data.content} markdown={isMarkdownPath(path)} />
              ) : fileQuery.isError ? (
                <p className="text-body-sm text-destructive">
                  <Trans>Could not load file</Trans>
                </p>
              ) : (
                <Skeleton className="h-24 w-full" />
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onBack} className="-ms-2">
      <ChevronLeft aria-hidden="true" />
      <Trans>All skills</Trans>
    </Button>
  );
}

/** A file as it reads: markdown formatted, anything else exactly as written. */
function FileContent({ text, markdown }: { text: string; markdown: boolean }) {
  if (markdown) {
    return (
      <div className="text-body" dir="auto">
        <ChatMarkdown>{text}</ChatMarkdown>
      </div>
    );
  }
  return (
    <pre className="overflow-x-auto rounded-xl bg-muted px-3.5 py-3 font-mono text-body-sm whitespace-pre">
      {text}
    </pre>
  );
}

/** Plain text to edit, as tall as the file; markdown can be read as it will look. */
function TextEditor({
  id,
  label,
  value,
  onChange,
  markdown,
  disabled,
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  markdown: boolean;
  disabled: boolean;
}) {
  const [previewing, setPreviewing] = useState(false);
  const preview = markdown && previewing;
  return (
    <div className="space-y-2">
      {markdown ? (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={!preview}
            onClick={() => setPreviewing(false)}
            className="aria-pressed:bg-muted"
          >
            <Trans>Write</Trans>
          </Button>
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={preview}
            onClick={() => setPreviewing(true)}
            className="aria-pressed:bg-muted"
          >
            <Trans>Preview</Trans>
          </Button>
        </div>
      ) : null}
      {preview ? (
        <div className="min-h-64 rounded-xl px-0.5">
          {value.trim() ? (
            <FileContent text={value} markdown />
          ) : (
            <p className="text-body-sm text-muted-foreground">
              <Trans>Nothing to preview yet.</Trans>
            </p>
          )}
        </div>
      ) : (
        <Textarea
          id={id}
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          rows={Math.min(28, Math.max(16, value.split("\n").length + 2))}
          className={monoField}
          dir="auto"
        />
      )}
    </div>
  );
}

function DocumentEditor({
  draft,
  onChange,
  disabled,
}: {
  draft: DocumentDraft;
  onChange: (next: DocumentDraft) => void;
  disabled: boolean;
}) {
  const { t } = useLingui();
  return (
    <div className="space-y-3">
      <Field>
        <FieldLabel htmlFor="skill-name">
          <Trans>Name</Trans>
        </FieldLabel>
        <Input
          id="skill-name"
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          disabled={disabled}
          maxLength={80}
          placeholder="weekly-report"
          dir="auto"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="skill-description">
          <Trans>Description</Trans>
        </FieldLabel>
        <Input
          id="skill-description"
          value={draft.description}
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
          disabled={disabled}
          maxLength={2000}
          dir="auto"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="skill-body">
          <Trans>Instructions</Trans>
        </FieldLabel>
        <TextEditor
          id="skill-body"
          label={t`Instructions`}
          value={draft.body}
          onChange={(body) => onChange({ ...draft, body })}
          markdown
          disabled={disabled}
        />
      </Field>
    </div>
  );
}
