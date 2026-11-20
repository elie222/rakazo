import { Trans, useLingui } from "@lingui/react/macro";
import type { MarketplaceBotAdminRow, MarketplaceBotSource } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import {
  Button,
  Checkbox,
  Label as ControlLabel,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  OptionSelect,
  Textarea,
} from "@rakazo/ui-web";
import { ArrowLeft } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useId, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { cronLabels } from "../../lib/routines/cron";
import type { ListingForm } from "./admin-bot-form";
import {
  BOT_CATEGORIES,
  copyFromBot,
  issuesByField,
  listingFields,
  newListing,
  parseListing,
} from "./admin-bot-form";
import { AdminBotListingPreview } from "./admin-bot-listing-preview";
import { AdminBotSourcePicker, NameTile, SourceCounts } from "./admin-bot-source-picker";

const EXAMPLE_FIELDS = new Set(["sample", "intro", "firstQuestion"]);
const COPIED_FIELDS = new Set(["instructions", "skills", "routines", "apps"]);

function Label({ children, required }: { children: ReactNode; required?: boolean }) {
  return (
    <span className="font-semibold text-foreground">
      {children}
      {required ? (
        <span aria-hidden className="ps-1 text-muted-foreground">
          *
        </span>
      ) : null}
    </span>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h2 className="text-body-lg font-semibold text-foreground">{children}</h2>;
}

/** A native disclosure, so the browser owns the arrow, keyboard and screen reader state. */
function Fold({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <details
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
      className="py-3.5"
    >
      <summary className="cursor-pointer select-none text-body-lg font-semibold text-foreground">
        {title}
      </summary>
      <div className="pt-4">{children}</div>
    </details>
  );
}

function TextField({
  label,
  required,
  value,
  onChange,
  error,
  ...input
}: {
  label: ReactNode;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
  error?: string;
} & Omit<ComponentProps<typeof Input>, "value" | "onChange" | "className" | "required">) {
  const id = useId();
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>
        <Label required={required}>{label}</Label>
      </FieldLabel>
      <Input
        id={id}
        value={value}
        aria-invalid={Boolean(error)}
        aria-required={required}
        onChange={(event) => onChange(event.target.value)}
        {...input}
      />
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

function AreaField({
  label,
  required,
  value,
  onChange,
  error,
  rows = 3,
  ...area
}: {
  label: ReactNode;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  rows?: number;
} & Omit<
  ComponentProps<typeof Textarea>,
  "value" | "onChange" | "className" | "rows" | "required"
>) {
  const id = useId();
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>
        <Label required={required}>{label}</Label>
      </FieldLabel>
      <Textarea
        id={id}
        rows={rows}
        value={value}
        aria-invalid={Boolean(error)}
        aria-required={required}
        onChange={(event) => onChange(event.target.value)}
        {...area}
      />
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

/**
 * Create or change a market listing: pick the bot it is built from, write what the market shows,
 * then check it exactly as users will see it before saving or publishing.
 */
export function AdminBotListingForm({ row }: { row: MarketplaceBotAdminRow | null }) {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const queries = useSpaceQueries();
  const [initial] = useState(() => (row ? listingFields(row.listing) : newListing()));
  const [initialJson] = useState(() => JSON.stringify(initial.form));
  const [form, setForm] = useState<ListingForm>(initial.form);
  const [fallbackId] = useState(() => `bot-${crypto.randomUUID().slice(0, 8)}`);
  const [source, setSource] = useState<MarketplaceBotSource | null>(null);
  const [nameEdited, setNameEdited] = useState(Boolean(row));
  const [step, setStep] = useState<"edit" | "preview">("edit");
  const [tried, setTried] = useState(false);
  const [exampleOpen, setExampleOpen] = useState(false);
  const [copiedOpen, setCopiedOpen] = useState(false);
  // Every skill the chosen bot could bring; the form keeps the ones that stay ticked.
  const [skillChoices, setSkillChoices] = useState(initial.form.skills);
  const [picking, setPicking] = useState(false);
  // A listing made before a failed publish is changed, not made again, when saved once more.
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);

  const parsed = useMemo(
    () => parseListing(form, initial.base, fallbackId),
    [form, initial.base, fallbackId],
  );
  const issues = useMemo(
    () => (parsed.success ? new Map() : issuesByField(parsed.error.issues)),
    [parsed],
  );
  const dirty = JSON.stringify(form) !== initialJson;

  const copy = useSave({
    save: async (picked: MarketplaceBotSource, client) => ({
      picked,
      draft: await client.botMarketplace.admin.fromBot({ botId: picked.botId }),
    }),
    onSaved: ({ picked, draft }) => {
      setForm((current) => copyFromBot(current, draft, nameEdited));
      setSkillChoices(draft.skills);
      setSource(picked);
      setPicking(false);
    },
  });

  const save = useSave({
    save: async (input: { listing: NonNullable<typeof parsed.data>; publish: boolean }, client) => {
      const slug = row?.slug ?? createdSlug;
      let target = slug;
      if (slug) {
        await client.botMarketplace.admin.update({ slug, listing: input.listing });
      } else {
        target = (await client.botMarketplace.admin.create({ listing: input.listing })).slug;
        setCreatedSlug(target);
      }
      if (input.publish && target) {
        await client.botMarketplace.admin.setStatus({ slug: target, status: "published" });
      }
    },
    stale: [queries.botMarketplace.admin.list.key()],
    closesScreen: true,
    onSaved: () => navigate("/admin/bots"),
  });

  const set = <K extends keyof ListingForm>(key: K, value: ListingForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  function problem(key: string): string | undefined {
    const issue = tried ? issues.get(key) : undefined;
    if (!issue) return undefined;
    if (issue.code === "too_small" && issue.minimum === 1) return t`Required`;
    return issue.message;
  }

  /** Opens the sections holding a problem, and says whether the form can go on. */
  function check(): boolean {
    setTried(true);
    if (parsed.success) return true;
    const keys = [...issues.keys()];
    if (keys.some((key) => EXAMPLE_FIELDS.has(key))) setExampleOpen(true);
    if (keys.some((key) => COPIED_FIELDS.has(key))) setCopiedOpen(true);
    return false;
  }

  function finish(publish: boolean) {
    if (!check() || !parsed.success) return;
    save.run({ listing: parsed.data, publish });
  }

  const categoryLabels = {
    personal: t`Personal`,
    engineering: t`Engineering`,
    sales: t`Sales`,
    operations: t`Operations`,
  };
  const categoryId = useId();
  const schedule = (crons: string[]) =>
    crons.map((cron) => formatCron(cron, cronLabels(i18n.locale))).join(", ");
  const saveLabel = !row || row.status === "draft" ? t`Save draft` : t`Save`;
  const canPublish = row?.status !== "published";
  const sourceName = source?.name ?? (row ? form.name : null);

  return (
    <>
      <form
        noValidate
        data-testid="bot-listing-form"
        className="space-y-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (step === "edit" && check()) setStep("preview");
        }}
      >
        <header className="space-y-3 border-b pb-5">
          <nav aria-label={t`Breadcrumb`} className="flex gap-2 text-body-sm text-muted-foreground">
            <Link to="/admin/bots" className="hover:text-foreground">
              <Trans>Bot market</Trans>
            </Link>
            <span aria-hidden>/</span>
            <span>
              <Trans>Listings</Trans>
            </span>
          </nav>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t`Back to Bot market`}
                onClick={() => navigate("/admin/bots")}
              >
                <ArrowLeft className="size-4 rtl:rotate-180" />
              </Button>
              <h1 className="text-heading1 font-semibold text-foreground">
                {row ? <Trans>Edit listing</Trans> : <Trans>New listing</Trans>}
              </h1>
            </div>
            {dirty || !row ? (
              <span className="pt-2 text-body-sm text-muted-foreground">
                <Trans>Unsaved</Trans>
              </span>
            ) : null}
          </div>
        </header>

        {step === "edit" ? (
          <>
            <section className="space-y-3">
              <Heading>
                <Trans>Source bot</Trans>
              </Heading>
              <div className="flex items-center gap-3 rounded-xl border border-border bg-muted px-4 py-3.5">
                {sourceName ? <NameTile name={sourceName} /> : null}
                <div className="min-w-0 flex-1">
                  {sourceName ? (
                    <>
                      <p className="truncate text-body-lg font-semibold text-foreground">
                        {sourceName}
                      </p>
                      <SourceCounts
                        space={source?.spaceName}
                        skills={form.skills.length}
                        routines={form.routines.length}
                      />
                    </>
                  ) : (
                    <p className="text-body text-muted-foreground">
                      <Trans>No bot chosen</Trans>
                    </p>
                  )}
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
                  {sourceName ? <Trans>Change</Trans> : <Trans>Choose a bot</Trans>}
                </Button>
              </div>
            </section>

            <section className="space-y-4">
              <Heading>
                <Trans>Listing</Trans>
              </Heading>
              <FieldGroup>
                <div className="grid gap-5 sm:grid-cols-[1fr_12rem]">
                  <TextField
                    label={t`Display name`}
                    required
                    value={form.name}
                    error={problem("name")}
                    onChange={(value) => {
                      setNameEdited(true);
                      set("name", value);
                    }}
                  />
                  <Field>
                    <FieldLabel htmlFor={categoryId}>
                      <Label required>
                        <Trans>Category</Trans>
                      </Label>
                    </FieldLabel>
                    <OptionSelect
                      id={categoryId}
                      required
                      value={form.category}
                      options={BOT_CATEGORIES.map((value) => ({
                        value,
                        label: categoryLabels[value],
                      }))}
                      onValueChange={(value) => set("category", value)}
                    />
                  </Field>
                </div>
                <TextField
                  label={t`One-line intro`}
                  required
                  value={form.tagline}
                  error={problem("tagline")}
                  onChange={(value) => set("tagline", value)}
                />
                <AreaField
                  label={t`What it does for users`}
                  required
                  value={form.outcomes}
                  error={problem("outcomes")}
                  onChange={(value) => set("outcomes", value)}
                />
              </FieldGroup>
            </section>

            <div className="divide-y divide-border border-y border-border">
              <Fold
                open={exampleOpen}
                onOpenChange={setExampleOpen}
                title={<Trans>Example and opening line</Trans>}
              >
                <FieldGroup>
                  <AreaField
                    label={t`Example output`}
                    required
                    value={form.sample}
                    error={problem("sample")}
                    onChange={(value) => set("sample", value)}
                  />
                  <AreaField
                    label={t`First message after install`}
                    value={form.intro}
                    error={problem("intro")}
                    onChange={(value) => set("intro", value)}
                  />
                  <TextField
                    label={t`First question`}
                    value={form.firstQuestion}
                    error={problem("firstQuestion")}
                    onChange={(value) => set("firstQuestion", value)}
                  />
                </FieldGroup>
              </Fold>
              <Fold
                open={copiedOpen}
                onOpenChange={setCopiedOpen}
                title={<Trans>Copied with the template</Trans>}
              >
                <FieldGroup>
                  <AreaField
                    label={t`Instructions`}
                    required
                    rows={6}
                    value={form.instructions}
                    error={problem("instructions")}
                    onChange={(value) => set("instructions", value)}
                  />
                  <TextField
                    label={t`Apps`}
                    value={form.apps}
                    error={problem("apps")}
                    placeholder="gmail, googlecalendar"
                    onChange={(value) => set("apps", value)}
                  />
                  {skillChoices.length ? (
                    <fieldset className="space-y-2">
                      <legend className="mb-2 text-body font-semibold text-foreground">
                        <Trans>Skills</Trans>
                      </legend>
                      {skillChoices.map((skill) => (
                        <ControlLabel key={skill.name} className="font-normal text-foreground">
                          <Checkbox
                            checked={form.skills.some((chosen) => chosen.name === skill.name)}
                            onCheckedChange={(checked) =>
                              set(
                                "skills",
                                skillChoices.filter((choice) =>
                                  choice.name === skill.name
                                    ? checked
                                    : form.skills.some((chosen) => chosen.name === choice.name),
                                ),
                              )
                            }
                          />
                          <span className="min-w-0 break-words">{skill.name}</span>
                        </ControlLabel>
                      ))}
                    </fieldset>
                  ) : null}
                  {form.routines.length ? (
                    <Field>
                      <FieldLabel>
                        <Trans>Routines</Trans>
                      </FieldLabel>
                      <ul className="space-y-1 text-body">
                        {form.routines.map((routine) => (
                          <li key={routine.name} className="flex flex-wrap gap-x-3">
                            <span>{routine.name}</span>
                            <span className="text-muted-foreground">{schedule(routine.crons)}</span>
                          </li>
                        ))}
                      </ul>
                    </Field>
                  ) : null}
                </FieldGroup>
              </Fold>
            </div>
          </>
        ) : (
          <section className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <Heading>
                <Trans>What users see</Trans>
              </Heading>
              <Button type="button" variant="outline" onClick={() => setStep("edit")}>
                <Trans>Back to edit</Trans>
              </Button>
            </div>
            {parsed.success ? (
              <AdminBotListingPreview
                listing={parsed.data}
                categoryLabel={categoryLabels[parsed.data.category]}
              />
            ) : null}
          </section>
        )}

        <div className="flex flex-wrap items-center justify-end gap-3">
          {save.error ? (
            <p role="alert" className="mr-auto text-body-sm text-destructive">
              {errorText(save.error, t`Could not save the listing`)}
            </p>
          ) : null}
          <Button
            type="button"
            variant={step === "edit" ? "outline" : "ghost"}
            disabled={save.pending}
            onClick={() => finish(false)}
          >
            {saveLabel}
          </Button>
          {step === "edit" ? (
            <Button type="submit">
              <Trans>Preview listing</Trans>
              <span aria-hidden>→</span>
            </Button>
          ) : canPublish ? (
            <Button type="button" disabled={save.pending} onClick={() => finish(true)}>
              <Trans>Publish to market</Trans>
            </Button>
          ) : null}
        </div>
      </form>
      {picking ? (
        <AdminBotSourcePicker
          busy={copy.pending}
          error={copy.error}
          onPick={copy.run}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </>
  );
}
