import { Trans, useLingui } from "@lingui/react/macro";
import type { Routine, RoutineEmailSenders } from "@rakazo/contracts";
import { ROUTINE_WATCH_MIN_MINUTES } from "@rakazo/contracts";
import { Button, Input, Switch, Textarea } from "@rakazo/ui-web";
import { Eye, GitBranch, Globe, Mail, MessageSquare, X } from "lucide-react";
import { useId } from "react";
import { AppSelect } from "../../components/AppSelect";
import { BotEmailAddressField } from "../../components/BotEmailAddressField";
import { authClient } from "../../lib/auth";
import type { RoutineWatchDraft } from "../../lib/routine-draft";

export function WatchTriggerCard({
  watch,
  state,
  onChange,
  onRemove,
}: {
  watch: RoutineWatchDraft;
  state: Routine["watchState"];
  onChange: (watch: RoutineWatchDraft) => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const status = !state
    ? null
    : state.outcome === "failed"
      ? t`Check failed: ${state.detail ?? ""}`
      : state.outcome === "changed"
        ? t`Last check ${new Date(state.checkedAt).toLocaleString()}: changed`
        : t`Last check ${new Date(state.checkedAt).toLocaleString()}: no changes`;
  return (
    <div className="rounded-xl border border-border p-3" data-testid="routine-watch-card">
      <div className="flex items-center gap-2.5 px-0.5">
        <Eye size={16} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
        <span className="flex-1 text-body-lg text-foreground">
          <Trans>When something changes</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Remove change trigger`}
          onClick={onRemove}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      <div className="mt-3 space-y-3">
        <AppSelect
          size="sm"
          aria-label={t`What to watch`}
          value={watch.kind}
          options={[
            { value: "files", label: t`Files or folders on the computer` },
            { value: "command", label: t`A command's output` },
            { value: "tool", label: t`An integration tool` },
          ]}
          onValueChange={(kind) => onChange({ ...watch, kind })}
        />
        {watch.kind === "files" ? (
          <Textarea
            aria-label={t`Files or folders, one per line`}
            placeholder={"inbox/\nreports/latest.csv"}
            value={watch.paths}
            onChange={(e) => onChange({ ...watch, paths: e.target.value })}
            rows={3}
          />
        ) : null}
        {watch.kind === "command" ? (
          <Input
            aria-label={t`Command`}
            placeholder="curl -s https://example.com/status"
            value={watch.command}
            onChange={(e) => onChange({ ...watch, command: e.target.value })}
            className="font-mono text-body-sm"
          />
        ) : null}
        {watch.kind === "tool" ? (
          <>
            <Input
              aria-label={t`Tool name`}
              placeholder="brain_changed"
              value={watch.tool}
              onChange={(e) => onChange({ ...watch, tool: e.target.value })}
              className="font-mono text-body-sm"
            />
            <Textarea
              aria-label={t`Tool arguments (JSON)`}
              value={watch.args}
              onChange={(e) => onChange({ ...watch, args: e.target.value })}
              rows={2}
              className="font-mono text-body-sm"
            />
          </>
        ) : null}
        {watch.kind !== "files" ? (
          <Input
            aria-label={t`Fields that mark a change`}
            placeholder={t`Fields to compare, e.g. id, modifiedTime (optional)`}
            value={watch.track}
            onChange={(e) => onChange({ ...watch, track: e.target.value })}
            className="font-mono text-body-sm"
          />
        ) : null}
        <label
          htmlFor={`${id}-every`}
          className="flex items-center gap-2 text-body text-muted-foreground"
        >
          <Trans>Check every</Trans>
          <Input
            id={`${id}-every`}
            type="number"
            min={ROUTINE_WATCH_MIN_MINUTES}
            max={1440}
            value={watch.everyMinutes || ""}
            onChange={(e) =>
              onChange({
                ...watch,
                everyMinutes: Number(e.target.value),
              })
            }
            onBlur={() =>
              onChange({
                ...watch,
                everyMinutes: Math.min(
                  1440,
                  Math.max(ROUTINE_WATCH_MIN_MINUTES, Math.round(watch.everyMinutes)),
                ),
              })
            }
            className="h-8 w-20"
          />
          <Trans>minutes</Trans>
        </label>
        <label
          htmlFor={`${id}-loud`}
          className="flex items-center gap-2 text-body text-muted-foreground"
        >
          <Switch
            id={`${id}-loud`}
            checked={watch.loud}
            onCheckedChange={(loud) => onChange({ ...watch, loud })}
          />
          <Trans>Post "No changes" in chat</Trans>
        </label>
        {status ? (
          <p
            data-testid="routine-watch-status"
            className={`text-body-sm ${state?.outcome === "failed" ? "text-destructive" : "text-muted-foreground/80"}`}
          >
            {status}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function MessageTriggerCard({
  provider,
  onRemove,
}: {
  provider: string;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const label =
    provider === "slack"
      ? t`Slack message`
      : provider === "teams"
        ? t`Teams message`
        : t`Message event`;
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-2.5 px-0.5">
        <MessageSquare size={16} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
        <span className="flex-1 text-body-lg text-foreground">{label}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Remove message trigger`}
          onClick={onRemove}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      <p className="mt-2.5 text-body text-muted-foreground/70">
        <Trans>Runs when this bot receives a verified message from this provider.</Trans>
      </p>
    </div>
  );
}

export function EmailTriggerCard({
  bot,
  domain,
  address,
  senders,
  onChange,
  onRemove,
}: {
  bot: { id: string; name: string };
  /** Null while loading, or when this server no longer receives email. */
  domain: string | null;
  address: string | null;
  senders: RoutineEmailSenders;
  onChange: (senders: RoutineEmailSenders) => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const ownerEmail = authClient.useSession().data?.user.email ?? "";
  const ownerDomain = ownerEmail.slice(ownerEmail.lastIndexOf("@") + 1);

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-2.5 px-0.5">
        <Mail size={16} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
        <span className="flex-1 text-body-lg text-foreground">
          <Trans>When an email arrives</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Remove email trigger`}
          onClick={onRemove}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      {domain ? (
        <div className="mt-2.5 space-y-2.5 text-body">
          <BotEmailAddressField bot={bot} domain={domain} address={address} />
          {ownerDomain ? (
            <AppSelect
              aria-label={t`Who can start it`}
              className="w-full"
              value={senders}
              options={[
                { value: "owner", label: t`Only me` },
                { value: "domain", label: t`Anyone at @${ownerDomain}` },
              ]}
              onValueChange={onChange}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function InboundTriggerCard({
  kind,
  saved,
  path,
  secret,
  configured,
  onRemove,
  onRotate,
}: {
  kind: "webhook" | "github";
  saved: boolean;
  path: string;
  secret: string | null;
  configured: boolean;
  onRemove: () => void;
  onRotate: () => void;
}) {
  const { t } = useLingui();
  const pending = !saved;
  const placeholder = t`Available after the routine is saved`;
  // GitHub delivery URL and signature header are fixed by bot id / protocol, so show
  // them before save. The shared secret still needs a saved routine to mint.
  const postValue = kind === "github" || !pending ? path : placeholder;
  const keyValue = pending
    ? placeholder
    : (secret ?? (configured ? t`Saved. Rotate to reveal.` : placeholder));
  const headerValue =
    kind === "github"
      ? "X-Hub-Signature-256: sha256=…"
      : pending
        ? placeholder
        : secret
          ? `Authorization: Bearer ${secret}`
          : configured
            ? "Authorization: Bearer …"
            : placeholder;
  const cellClass =
    "break-all rounded-lg bg-muted px-2.5 py-1.5 font-mono text-label text-foreground/75";

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-2.5 px-0.5">
        {kind === "github" ? (
          <GitBranch size={16} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
        ) : (
          <Globe size={16} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
        )}
        <span className="flex-1 text-body-lg text-foreground">
          {kind === "github" ? <Trans>Git event</Trans> : <Trans>When a webhook fires</Trans>}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={kind === "github" ? t`Remove Git event` : t`Remove webhook`}
          onClick={onRemove}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      <div className="mt-2.5 space-y-2.5 text-body">
        <div className="block text-muted-foreground/70">
          <Trans>POST to</Trans>
          <div className={`mt-1 ${cellClass}`}>{postValue}</div>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground/70">
          <span className="shrink-0">
            <Trans>key</Trans>
          </span>
          <div className={`min-w-0 flex-1 ${cellClass}`}>{keyValue}</div>
        </div>
        <div className="block text-muted-foreground/70">
          <Trans>header</Trans>
          <div className={`mt-1 ${cellClass}`}>{headerValue}</div>
        </div>
        {saved && configured && !secret ? (
          <Button
            variant="link"
            size="xs"
            onClick={onRotate}
            className="px-0 text-muted-foreground"
          >
            <Trans>Rotate key</Trans>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
