import { Trans, useLingui } from "@lingui/react/macro";
import type { MarketplaceBotAdminRow, MarketplaceBotStatus } from "@rakazo/contracts";
import { MarketplaceBotSchema } from "@rakazo/contracts";
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Star, X } from "lucide-react";
import { useMemo, useState } from "react";
import { BotMarketplaceDetail } from "../components/bot-marketplace/bot-marketplace-detail";
import { useSpaceQueries } from "../lib/query/query";
import { rpc } from "../lib/query/rpc";
import { errorText } from "../lib/query/user-error";

type StatusTab = "all" | MarketplaceBotStatus;

const NEW_LISTING = {
  id: "my-bot",
  version: 1,
  name: "My bot",
  summary: "One line about the result it delivers.",
  sample: "An example of what the bot sends.",
  description: "",
  instructions: "What the bot does, and what it never does without confirmation.",
  skills: [],
  routines: [],
  apps: [],
  author: { name: "Rakazo Team" },
  license: "Apache-2.0",
  category: "personal",
  tagline: "One line, result-oriented.",
  outcomes: ["What the user gets."],
};

/** The ops console: maintain the catalog online — draft, edit, publish, feature, sort. */
export function AdminBotsPanel() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<StatusTab>("all");
  const [pending, setPending] = useState<string | null>(null);
  const [editing, setEditing] = useState<MarketplaceBotAdminRow | "new" | null>(null);
  const rows = useQuery(
    queries.botMarketplace.admin.list.queryOptions({
      input: tab === "all" ? {} : { status: tab },
    }),
  );

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: queries.botMarketplace.admin.list.key() });
  }

  async function act(slug: string, run: () => Promise<unknown>, failure: string) {
    setPending(slug);
    try {
      await run();
      await refresh();
    } catch (err) {
      toast.error(errorText(err, failure));
    } finally {
      setPending(null);
    }
  }

  const list = rows.data ?? [];

  return (
    <div data-testid="admin-bots" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={(value) => setTab(value as StatusTab)}>
          <TabsList>
            <TabsTrigger value="all" className="px-3">
              <Trans>All</Trans>
            </TabsTrigger>
            <TabsTrigger value="draft" className="px-3">
              <Trans>Drafts</Trans>
            </TabsTrigger>
            <TabsTrigger value="published" className="px-3">
              <Trans>Published</Trans>
            </TabsTrigger>
            <TabsTrigger value="unpublished" className="px-3">
              <Trans>Unpublished</Trans>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button onClick={() => setEditing("new")}>
          <Trans>New bot</Trans>
        </Button>
      </div>

      {rows.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      ) : rows.isError ? (
        <div role="alert" className="flex items-center gap-3 text-body text-destructive">
          {errorText(rows.error, t`Couldn't load the catalog`)}
          <Button variant="outline" size="sm" onClick={() => void rows.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : list.length === 0 ? (
        <p className="py-10 text-center text-body text-muted-foreground">
          <Trans>No bots here yet.</Trans>
        </p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
          {list.map((row) => (
            <li key={row.slug} className="flex items-center gap-3 px-4 py-3">
              <button
                type="button"
                className={`shrink-0 rounded-md p-1 focus-visible:outline-none ${
                  row.featured ? "text-foreground" : "text-muted-foreground/50"
                }`}
                aria-label={t`Featured`}
                aria-pressed={row.featured}
                disabled={pending === row.slug}
                onClick={() =>
                  void act(
                    row.slug,
                    () =>
                      rpc.botMarketplace.admin.update({ slug: row.slug, featured: !row.featured }),
                    t`Could not update the bot`,
                  )
                }
              >
                <Star size={16} fill={row.featured ? "currentColor" : "none"} />
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-body-lg font-medium text-foreground">
                  {row.listing.name}
                </p>
                <p className="truncate text-body-sm text-muted-foreground">
                  {row.slug} · v{row.version} · {row.listing.category}
                </p>
              </div>
              <Badge variant={row.status === "published" ? "secondary" : "outline"}>
                {row.status === "published" ? (
                  <Trans>Published</Trans>
                ) : row.status === "draft" ? (
                  <Trans>Draft</Trans>
                ) : (
                  <Trans>Unpublished</Trans>
                )}
              </Badge>
              <Button variant="ghost" size="sm" onClick={() => setEditing(row)}>
                <Trans>Edit</Trans>
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pending === row.slug}
                onClick={() =>
                  void act(
                    row.slug,
                    () =>
                      rpc.botMarketplace.admin.setStatus({
                        slug: row.slug,
                        status: row.status === "published" ? "unpublished" : "published",
                      }),
                    t`Could not update the bot`,
                  )
                }
              >
                {row.status === "published" ? <Trans>Unpublish</Trans> : <Trans>Publish</Trans>}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <BotEditor
          row={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/** JSON editor with strict validation and the same preview users will see. */
function BotEditor({
  row,
  onClose,
  onSaved,
}: {
  row: MarketplaceBotAdminRow | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [text, setText] = useState(() => JSON.stringify(row ? row.listing : NEW_LISTING, null, 2));
  const [sortOrder, setSortOrder] = useState(() => String(row?.sortOrder ?? 0));
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const result = useMemo(() => {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        ok: false as const,
        issues: [{ path: [] as PropertyKey[], message: t`Not valid JSON.` }],
      };
    }
    const parsed = MarketplaceBotSchema.safeParse(json);
    return parsed.success
      ? { ok: true as const, listing: parsed.data }
      : { ok: false as const, issues: parsed.error.issues };
  }, [text, t]);
  const valid = result.ok;

  async function save() {
    if (!result.ok) return;
    setSaving(true);
    try {
      if (row) {
        await rpc.botMarketplace.admin.update({
          slug: row.slug,
          listing: result.listing,
          sortOrder: Number.parseInt(sortOrder, 10) || 0,
        });
      } else {
        await rpc.botMarketplace.admin.create({ listing: result.listing });
      }
      await onSaved();
    } catch (err) {
      toast.error(errorText(err, t`Could not save the bot`));
      setSaving(false);
    }
  }

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
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-8 pt-5 pb-8">
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={18}
            spellCheck={false}
            className="font-mono text-body-sm"
            aria-label={t`Listing JSON`}
            data-testid="bot-listing-json"
          />
          {!result.ok ? (
            <ul role="alert" className="space-y-1 text-body-sm text-destructive">
              {result.issues.slice(0, 8).map((issue) => (
                <li key={`${issue.path.join(".")}:${issue.message}`}>
                  {issue.path.join(".") || "listing"}: {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!valid}
                aria-pressed={preview}
                onClick={() => setPreview(!preview)}
              >
                <Trans>Preview</Trans>
              </Button>
              <span className="flex items-center gap-2 text-body-sm text-muted-foreground">
                <Trans>Sort order</Trans>
                <Input
                  type="number"
                  value={sortOrder}
                  onChange={(event) => setSortOrder(event.target.value)}
                  className="h-8 w-20"
                  aria-label={t`Sort order`}
                />
              </span>
            </div>
            <Button disabled={!valid || saving} onClick={() => void save()}>
              {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
            </Button>
          </div>
          {preview && result.ok ? <BotMarketplaceDetail listing={result.listing} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
