import { Trans, useLingui } from "@lingui/react/macro";
import type { MarketplaceBot, MarketplaceBotAdminRow } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Disclosure,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  OptionSelect,
  Textarea,
} from "@rakazo/ui-web";
import { Plus, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useId, useMemo, useState } from "react";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import type { BotForm, FormIssue } from "./admin-bot-form";
import {
  BOT_CATEGORIES,
  emptyForm,
  formFromListing,
  issuesByField,
  MAX_ROUTINES,
  MAX_SKILLS,
  parseForm,
  slugFromName,
} from "./admin-bot-form";
import { BotMarketplaceDetail } from "./bot-marketplace-detail";

const DETAIL_FIELDS =
  /^(description|intro|firstQuestion|author|license|homepage|setupMinutes|tags|versionNote)/;
const BEHAVIOR_FIELDS = /^(skills|routines|apps)/;

/** A labeled text field that shows its own problem once the form has been tried. */
function TextField({
  label,
  value,
  onChange,
  error,
  ...input
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  error?: string;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "className">) {
  const id = useId();
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(event.target.value)}
        {...input}
      />
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

function AreaField({
  label,
  value,
  onChange,
  error,
  hint,
  rows = 3,
  ...area
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: ReactNode;
  rows?: number;
} & Omit<React.ComponentProps<typeof Textarea>, "value" | "onChange" | "className" | "rows">) {
  const id = useId();
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        rows={rows}
        value={value}
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(event.target.value)}
        {...area}
      />
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

/** Create or edit a market listing with a form; the preview shows what users will see. */
export function AdminBotEditor({
  row,
  onClose,
}: {
  row: MarketplaceBotAdminRow | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const categoryId = useId();
  const [form, setForm] = useState<BotForm>(() =>
    row ? formFromListing(row.listing) : emptyForm(),
  );
  // The slug follows the name until someone types their own.
  const [slugEdited, setSlugEdited] = useState(false);
  const [sortOrder, setSortOrder] = useState(() => String(row?.sortOrder ?? 0));
  const [preview, setPreview] = useState(false);
  const [tried, setTried] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [behaviorOpen, setBehaviorOpen] = useState(false);
  const parsed = useMemo(() => parseForm(form), [form]);
  // The preview sits below the form: bring it into view when it opens.
  const showPreview = useCallback((node: HTMLDivElement | null) => {
    const pane = node?.parentElement;
    if (node && pane)
      pane.scrollTop += node.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  }, []);
  const issues = useMemo(
    () => (parsed.success ? new Map<string, FormIssue>() : issuesByField(parsed.error.issues)),
    [parsed],
  );
  const save = useSave({
    save: (input: { listing: MarketplaceBot; sortOrder: number }, client) =>
      row
        ? client.botMarketplace.admin.update({
            slug: row.slug,
            listing: input.listing,
            sortOrder: input.sortOrder,
          })
        : client.botMarketplace.admin.create({ listing: input.listing }),
    stale: [queries.botMarketplace.admin.list.key()],
    closesScreen: true,
    onSaved: onClose,
  });

  const set = <K extends keyof BotForm>(key: K, value: BotForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const patchSkill = (index: number, change: Partial<BotForm["skills"][number]>) =>
    set(
      "skills",
      form.skills.map((other, at) => (at === index ? { ...other, ...change } : other)),
    );
  const patchRoutine = (index: number, change: Partial<BotForm["routines"][number]>) =>
    set(
      "routines",
      form.routines.map((other, at) => (at === index ? { ...other, ...change } : other)),
    );

  function issueText(key: string): string | undefined {
    const issue = tried ? issues.get(key) : undefined;
    if (!issue) return undefined;
    if (key === "id" && !form.id.trim()) return t`Required`;
    if (issue.code === "too_small" && issue.minimum === 1) return t`Required`;
    if (issue.code === "invalid_format" && issue.format === "url")
      return t`Enter a web address starting with https://`;
    if (key === "id") return t`Use lowercase letters, numbers and hyphens`;
    if (/^skills\.\d+\.name$/.test(key))
      return t`Start with a letter; letters, numbers, hyphens and spaces only`;
    if (issue.code === "invalid_type") return t`Enter a whole number`;
    return issue.message;
  }

  function submit() {
    setTried(true);
    if (!parsed.success) {
      const keys = [...issues.keys()];
      if (keys.some((key) => DETAIL_FIELDS.test(key))) setDetailsOpen(true);
      if (keys.some((key) => BEHAVIOR_FIELDS.test(key))) setBehaviorOpen(true);
      return;
    }
    save.run({
      listing: parsed.data,
      sortOrder: Number.parseInt(sortOrder, 10) || 0,
    });
  }

  const categoryLabels = {
    personal: t`Personal`,
    engineering: t`Engineering`,
    sales: t`Sales`,
    operations: t`Operations`,
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent showCloseButton={false} size="lg" className="bg-card">
        <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
          <DialogTitle className="text-heading2 text-foreground">
            {row ? <Trans>Edit bot</Trans> : <Trans>New bot</Trans>}
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close editor`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
        <form
          noValidate
          data-testid="bot-listing-form"
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-8 pt-5 pb-6">
            <FieldGroup>
              <TextField
                label={t`Name`}
                value={form.name}
                error={issueText("name")}
                placeholder={t`Morning briefing`}
                onChange={(name) => {
                  setForm((current) => ({
                    ...current,
                    name,
                    id: row || slugEdited ? current.id : slugFromName(name),
                  }));
                }}
              />
              {row ? null : (
                <TextField
                  label={t`Slug`}
                  value={form.id}
                  error={issueText("id")}
                  placeholder="morning-briefing"
                  onChange={(id) => {
                    setSlugEdited(true);
                    set("id", id);
                  }}
                />
              )}
              <TextField
                label={t`Tagline`}
                value={form.tagline}
                error={issueText("tagline")}
                placeholder={t`Your weekday morning overview.`}
                onChange={(value) => set("tagline", value)}
              />
              <Field>
                <FieldLabel htmlFor={categoryId}>
                  <Trans>Category</Trans>
                </FieldLabel>
                <OptionSelect
                  id={categoryId}
                  value={form.category}
                  options={BOT_CATEGORIES.map((value) => ({
                    value,
                    label: categoryLabels[value],
                  }))}
                  onValueChange={(value) => set("category", value)}
                />
              </Field>
              <TextField
                label={t`Summary`}
                value={form.summary}
                error={issueText("summary")}
                placeholder={t`A weekday morning overview.`}
                onChange={(value) => set("summary", value)}
              />
              <AreaField
                label={t`Outcomes`}
                value={form.outcomes}
                error={issueText("outcomes")}
                hint={t`One per line`}
                placeholder={t`A scannable morning briefing.`}
                onChange={(value) => set("outcomes", value)}
              />
              <AreaField
                label={t`Instructions`}
                value={form.instructions}
                error={issueText("instructions")}
                rows={6}
                placeholder={t`What the bot does, and what it never does without confirmation.`}
                onChange={(value) => set("instructions", value)}
              />
              <AreaField
                label={t`Sample message`}
                value={form.sample}
                error={issueText("sample")}
                hint={t`Markdown`}
                placeholder={t`**Today**\n- 10:00 design review`}
                onChange={(value) => set("sample", value)}
              />
            </FieldGroup>

            <Disclosure
              open={behaviorOpen}
              onOpenChange={setBehaviorOpen}
              summary={<Trans>Skills, routines and apps</Trans>}
              summaryClassName="text-body font-medium text-foreground"
              contentClassName="pt-4"
            >
              <FieldGroup>
                <TextField
                  label={t`Apps`}
                  value={form.apps}
                  error={issueText("apps")}
                  placeholder="gmail, googlecalendar"
                  onChange={(value) => set("apps", value)}
                />
                {form.skills.map((skill, index) => (
                  <fieldset
                    key={index}
                    className="min-w-0 space-y-4 rounded-xl border border-border/70 p-4"
                  >
                    <legend className="sr-only">{t`Skill ${index + 1}`}</legend>
                    <div className="flex items-center justify-between gap-3">
                      <p aria-hidden className="text-body font-medium">
                        <Trans>Skill {index + 1}</Trans>
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t`Remove skill ${index + 1}`}
                        onClick={() =>
                          set(
                            "skills",
                            form.skills.filter((_, at) => at !== index),
                          )
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <TextField
                      label={t`Name`}
                      value={skill.name}
                      error={issueText(`skills.${index}.name`)}
                      onChange={(value) => patchSkill(index, { name: value })}
                    />
                    <TextField
                      label={t`Description`}
                      value={skill.description}
                      error={issueText(`skills.${index}.description`)}
                      onChange={(value) => patchSkill(index, { description: value })}
                    />
                    <AreaField
                      label={t`Instructions`}
                      value={skill.body}
                      rows={4}
                      error={issueText(`skills.${index}.body`)}
                      onChange={(value) => patchSkill(index, { body: value })}
                    />
                  </fieldset>
                ))}
                {form.skills.length < MAX_SKILLS ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={() =>
                      set("skills", [...form.skills, { name: "", description: "", body: "" }])
                    }
                  >
                    <Plus />
                    <Trans>Add skill</Trans>
                  </Button>
                ) : null}
                {form.routines.map((routine, index) => (
                  <fieldset
                    key={index}
                    className="min-w-0 space-y-4 rounded-xl border border-border/70 p-4"
                  >
                    <legend className="sr-only">{t`Routine ${index + 1}`}</legend>
                    <div className="flex items-center justify-between gap-3">
                      <p aria-hidden className="text-body font-medium">
                        <Trans>Routine {index + 1}</Trans>
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t`Remove routine ${index + 1}`}
                        onClick={() =>
                          set(
                            "routines",
                            form.routines.filter((_, at) => at !== index),
                          )
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <TextField
                      label={t`Name`}
                      value={routine.name}
                      error={issueText(`routines.${index}.name`)}
                      onChange={(value) => patchRoutine(index, { name: value })}
                    />
                    <AreaField
                      label={t`Prompt`}
                      value={routine.prompt}
                      error={issueText(`routines.${index}.prompt`)}
                      onChange={(value) => patchRoutine(index, { prompt: value })}
                    />
                    <AreaField
                      label={t`Schedule`}
                      value={routine.crons}
                      rows={2}
                      hint={t`One cron expression per line`}
                      placeholder="0 8 * * 1-5"
                      error={issueText(`routines.${index}.crons`)}
                      onChange={(value) => patchRoutine(index, { crons: value })}
                    />
                  </fieldset>
                ))}
                {form.routines.length < MAX_ROUTINES ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={() =>
                      set("routines", [...form.routines, { name: "", prompt: "", crons: "" }])
                    }
                  >
                    <Plus />
                    <Trans>Add routine</Trans>
                  </Button>
                ) : null}
              </FieldGroup>
            </Disclosure>

            <Disclosure
              open={detailsOpen}
              onOpenChange={setDetailsOpen}
              summary={<Trans>More details</Trans>}
              summaryClassName="text-body font-medium text-foreground"
              contentClassName="pt-4"
            >
              <FieldGroup>
                <AreaField
                  label={t`Description`}
                  value={form.description}
                  error={issueText("description")}
                  onChange={(value) => set("description", value)}
                />
                <AreaField
                  label={t`First message`}
                  value={form.intro}
                  error={issueText("intro")}
                  onChange={(value) => set("intro", value)}
                />
                <TextField
                  label={t`First question`}
                  value={form.firstQuestion}
                  error={issueText("firstQuestion")}
                  onChange={(value) => set("firstQuestion", value)}
                />
                <TextField
                  label={t`Author`}
                  value={form.authorName}
                  error={issueText("author.name")}
                  onChange={(value) => set("authorName", value)}
                />
                <TextField
                  label={t`Author link`}
                  type="url"
                  value={form.authorUrl}
                  error={issueText("author.url")}
                  placeholder="https://"
                  onChange={(value) => set("authorUrl", value)}
                />
                <TextField
                  label={t`License`}
                  value={form.license}
                  error={issueText("license")}
                  onChange={(value) => set("license", value)}
                />
                <TextField
                  label={t`Homepage`}
                  type="url"
                  value={form.homepage}
                  error={issueText("homepage")}
                  placeholder="https://"
                  onChange={(value) => set("homepage", value)}
                />
                <TextField
                  label={t`Setup minutes`}
                  inputMode="numeric"
                  value={form.setupMinutes}
                  error={issueText("setupMinutes")}
                  onChange={(value) => set("setupMinutes", value)}
                />
                <TextField
                  label={t`Tags`}
                  value={form.tags}
                  error={issueText("tags")}
                  placeholder="morning, email"
                  onChange={(value) => set("tags", value)}
                />
                {row ? (
                  <TextField
                    label={t`What changed`}
                    value={form.versionNote}
                    error={issueText("versionNote")}
                    onChange={(value) => set("versionNote", value)}
                  />
                ) : null}
                {row ? (
                  <TextField
                    label={t`Sort order`}
                    type="number"
                    value={sortOrder}
                    onChange={setSortOrder}
                  />
                ) : null}
              </FieldGroup>
            </Disclosure>

            {preview && parsed.success ? (
              <div ref={showPreview}>
                <BotMarketplaceDetail listing={parsed.data} />
              </div>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-3 border-t px-8 py-4">
            {save.error ? (
              <p role="alert" className="mr-auto text-body-sm text-destructive">
                {errorText(save.error, t`Could not save the bot`)}
              </p>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              aria-pressed={preview}
              onClick={() => {
                if (!parsed.success) submit();
                else setPreview(!preview);
              }}
            >
              <Trans>Preview</Trans>
            </Button>
            <Button type="submit" disabled={save.pending}>
              {save.pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
