import { Trans, useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";
import { ROUTINE_NAME_MAX_LENGTH } from "@rakazo/contracts";
import { cronFromPreset, isOneShotRoutineCrons, routineCanEnd, wallClock } from "@rakazo/core";
import {
  Button,
  Field,
  FieldLabel,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  Switch,
  Textarea,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, X } from "lucide-react";
import { useId, useState } from "react";
import { useIdentityConfirmation } from "../../components/account/ConfirmIdentityDialog";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useSpaceQueries } from "../../lib/query/query";
import type { RoutineDraftState } from "../../lib/routines/routine-draft";
import {
  routineDraftDirty,
  routineDraftEventTriggered,
  routineNeedsOneShotArm,
} from "../../lib/routines/routine-draft";
import { RoutineRunHistory } from "./RoutineRunHistory";
import { RoutineSchedule } from "./RoutineSchedule";
import { RoutineOwnerNote } from "./routine-editor/access-note";
import { AddTriggerMenu } from "./routine-editor/add-trigger-menu";
import { RoutineModelSettings } from "./routine-editor/model-settings";
import {
  EmailTriggerCard,
  InboundTriggerCard,
  MessageTriggerCard,
  WatchTriggerCard,
} from "./routine-editor/trigger-cards";

export function RoutineEditor({
  bot,
  draft,
  onChange,
  editing,
  timezone,
  webhook,
  githubPath,
  messageProviders,
  saving,
  running,
  error,
  onBack,
  onClose,
  onSave,
  onSetActive,
  onCopy,
  onTestRun,
  onDelete,
  onEnsureWebhook,
  onRevealWebhook,
  onHideWebhook,
}: {
  bot: { id: string; name: string };
  draft: RoutineDraftState;
  onChange: (next: RoutineDraftState) => void;
  editing: Routine | null;
  timezone: string;
  webhook: { path: string; secret: string | null; configured: boolean };
  githubPath: string;
  messageProviders: string[];
  saving: boolean;
  running: boolean;
  error: string | null;
  onBack: () => void;
  onClose: () => void;
  onSave: () => void;
  /** Turns another member's routine on or off at once, since nothing else in it can be saved. */
  onSetActive: (active: boolean) => void;
  /** Opens a new routine like another member's, which runs as the viewer once saved. */
  onCopy: () => void;
  onTestRun: () => void;
  onDelete: () => void;
  onEnsureWebhook: () => Promise<void>;
  onRevealWebhook: () => Promise<void>;
  onHideWebhook: () => void;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  // Going back or closing with unsaved edits asks first; a clean editor leaves at once.
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  // The run time a one-time routine starts with is made from the clock, so remember it per routine.
  // Only an unarmed one-time routine starts with one; any other keeps an edit made while saving.
  const openedRunAt = () =>
    editing && routineNeedsOneShotArm(editing, editing.crons) ? draft.runAtLocal : "";
  const [opened, setOpened] = useState(() => ({ editing, runAtLocal: openedRunAt() }));
  if (opened.editing !== editing) setOpened({ editing, runAtLocal: openedRunAt() });
  const leave = (exit: () => void) =>
    routineDraftDirty(draft, editing, opened.runAtLocal) ? setLeaving(() => exit) : exit();
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  // Closing the confirmation is a choice, and other failures show as the editor's error.
  const revealWebhook = () => void withIdentityConfirmation(onRevealWebhook).catch(() => undefined);
  const queries = useSpaceQueries();
  const scheduleStatus = useQuery({
    ...queries.routines.list.queryOptions({ input: { botId: editing?.botId ?? "" } }),
    enabled: editing !== null && draft.active,
    refetchOnWindowFocus: "always",
    select: (routines) => routines.find((routine) => routine.id === editing?.id) ?? null,
  });
  // Null when this server receives no email or the bot is another member's, which hides the trigger.
  const email = useQuery(queries.bots.emailAddress.queryOptions({ input: { botId: bot.id } })).data;
  const scheduleDelayed =
    !scheduleStatus.isError &&
    (scheduleStatus.data === undefined
      ? editing?.scheduleDelayed
      : scheduleStatus.data?.scheduleDelayed);
  const hasTriggers =
    draft.schedules.length > 0 ||
    draft.webhookEnabled ||
    draft.githubEnabled ||
    Boolean(draft.messageProvider) ||
    Boolean(draft.emailSenders) ||
    Boolean(draft.watch);
  const canTest = Boolean(editing) && !saving && !running;
  // Only the owner changes another member's routine; anyone may still turn it on or off.
  const readOnly = editing?.editable === false;
  const draftCrons = draft.schedules.map(cronFromPreset);
  const needsOneShotArm = editing != null && routineNeedsOneShotArm(editing, draftCrons);
  const repeats = routineCanEnd(
    draftCrons,
    draft.watch !== null,
    routineDraftEventTriggered(draft),
  );

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => leave(onBack)}
          className="text-muted-foreground"
          aria-label={t`Back`}
        >
          <ChevronLeft className="size-4.5" strokeWidth={1.75} />
        </Button>
        <div className="text-body-lg font-medium text-foreground">
          <Trans>Routine</Trans>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => leave(onClose)}
          className="text-muted-foreground"
          aria-label={t`Close`}
        >
          <X className="size-4.5" strokeWidth={1.75} />
        </Button>
      </div>

      <RoutineOwnerNote routine={editing} />

      <div className="mb-5 flex items-center justify-between gap-3">
        <label
          htmlFor={`${fieldId}-active`}
          className="flex items-center gap-2.5 text-body text-foreground/75"
        >
          <Switch
            id={`${fieldId}-active`}
            checked={draft.active}
            // Arming a one-time routine sets when it runs, which only its owner decides.
            disabled={readOnly && (saving || needsOneShotArm)}
            onCheckedChange={(active) =>
              readOnly ? onSetActive(active) : onChange({ ...draft, active })
            }
          />
          <Trans>Active</Trans>
        </label>
        <div className="flex items-center gap-2">
          {/* A draft is discarded by going back; only a saved routine can be deleted. */}
          {editing ? (
            <Button variant="secondary" disabled={saving || running} onClick={onDelete}>
              <Trans>Delete</Trans>
            </Button>
          ) : null}
          <Button variant="secondary" disabled={!canTest} onClick={onTestRun}>
            {running ? t`Running…` : t`Run now`}
          </Button>
        </div>
      </div>

      {draft.active && scheduleDelayed ? (
        <p role="status" className="mb-5 text-body text-warning">
          <Trans>Schedule delayed</Trans>
        </p>
      ) : null}

      <fieldset disabled={readOnly} className="min-w-0">
        <label htmlFor={`${fieldId}-name`} className="block text-body text-muted-foreground">
          <Trans>Name</Trans>
          <Input
            id={`${fieldId}-name`}
            value={draft.name}
            maxLength={ROUTINE_NAME_MAX_LENGTH}
            placeholder={t`Name this routine`}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            className="mt-2"
          />
        </label>

        <label htmlFor={`${fieldId}-prompt`} className="mt-5 block text-body text-muted-foreground">
          <Trans>Instruction</Trans>
          <Textarea
            id={`${fieldId}-prompt`}
            value={draft.prompt}
            placeholder={t`What should this routine do each time it runs?`}
            onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
            rows={4}
            className="mt-2"
          />
        </label>

        <div className="mt-5 text-body text-muted-foreground">
          <div className="flex items-center gap-2">
            <Trans>When to run</Trans>
            <span className="text-label text-muted-foreground/70">{timezone}</span>
            <RoutineModelSettings
              draft={draft}
              onChange={onChange}
              fieldId={fieldId}
              computerOffered={editing?.useComputer !== undefined}
            />
          </div>

          <div className="mt-2 space-y-2">
            {draft.schedules.map((preset, index) => (
              <RoutineSchedule
                key={index}
                value={preset}
                onChange={(next) =>
                  onChange({
                    ...draft,
                    schedules: draft.schedules.map((item, i) => (i === index ? next : item)),
                  })
                }
                onRemove={() =>
                  onChange({ ...draft, schedules: draft.schedules.filter((_, i) => i !== index) })
                }
              />
            ))}

            {draft.webhookEnabled ? (
              <InboundTriggerCard
                kind="webhook"
                saved={Boolean(editing)}
                path={webhook.path}
                secret={webhook.secret}
                configured={webhook.configured}
                onRemove={() => onChange({ ...draft, webhookEnabled: false })}
                onRotate={() => void onEnsureWebhook()}
                onReveal={revealWebhook}
                onHide={onHideWebhook}
              />
            ) : null}

            {draft.githubEnabled ? (
              <InboundTriggerCard
                kind="github"
                saved={Boolean(editing)}
                path={githubPath}
                secret={webhook.secret}
                configured={webhook.configured}
                onRemove={() => onChange({ ...draft, githubEnabled: false })}
                onRotate={() => void onEnsureWebhook()}
                onReveal={revealWebhook}
                onHide={onHideWebhook}
              />
            ) : null}

            {draft.watch ? (
              <WatchTriggerCard
                watch={draft.watch}
                state={editing?.watch ? editing.watchState : null}
                onChange={(watch) => onChange({ ...draft, watch })}
                onRemove={() => onChange({ ...draft, watch: null })}
              />
            ) : null}

            {draft.messageProvider ? (
              <MessageTriggerCard
                provider={draft.messageProvider}
                onRemove={() => onChange({ ...draft, messageProvider: null })}
              />
            ) : null}

            {/* Shown without email too, so a server that stopped receiving mail still lets it go. */}
            {draft.emailSenders ? (
              <EmailTriggerCard
                key={bot.id}
                bot={bot}
                domain={email?.domain ?? null}
                address={email?.address ?? null}
                senders={draft.emailSenders}
                onChange={(emailSenders) => onChange({ ...draft, emailSenders })}
                onRemove={() => onChange({ ...draft, emailSenders: null })}
              />
            ) : null}

            {repeats ? (
              <Field>
                <FieldLabel htmlFor={`${fieldId}-ends`} className="font-normal">
                  <Trans>Ends</Trans>
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id={`${fieldId}-ends`}
                    type="date"
                    value={draft.endsOn}
                    min={wallClock(new Date(), timezone).slice(0, 10)}
                    onChange={(e) => onChange({ ...draft, endsOn: e.target.value })}
                  />
                  {draft.endsOn && !readOnly ? (
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        size="icon-sm"
                        aria-label={t`Remove end date`}
                        onClick={() => onChange({ ...draft, endsOn: "" })}
                      >
                        <X />
                      </InputGroupButton>
                    </InputGroupAddon>
                  ) : null}
                </InputGroup>
              </Field>
            ) : null}

            {needsOneShotArm ? (
              <label
                htmlFor={`${fieldId}-run-at`}
                className="block text-body text-muted-foreground"
              >
                <Trans>Run at</Trans>
                <Input
                  id={`${fieldId}-run-at`}
                  type="datetime-local"
                  value={draft.runAtLocal}
                  onChange={(e) => onChange({ ...draft, runAtLocal: e.target.value })}
                  aria-label={t`Run at`}
                  className="mt-2"
                />
              </label>
            ) : null}
          </div>

          {readOnly ? null : (
            <AddTriggerMenu
              draft={draft}
              onChange={onChange}
              fieldId={fieldId}
              messageProviders={messageProviders}
              emailAvailable={Boolean(email)}
              webhookConfigured={webhook.configured}
              onEnsureWebhook={onEnsureWebhook}
            />
          )}
        </div>
      </fieldset>

      <div className="mt-5">
        {readOnly ? (
          // A one-time routine is set up from chat, so it has no copy here.
          isOneShotRoutineCrons(editing.crons) ? null : (
            <Button variant="secondary" disabled={saving || running} onClick={onCopy}>
              <Trans>Make a copy</Trans>
            </Button>
          )
        ) : (
          <Button disabled={saving || running || !hasTriggers} onClick={onSave}>
            {saving ? t`Saving…` : t`Save`}
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-body-sm text-destructive">
          {error}
        </p>
      ) : null}

      {editing ? <RoutineRunHistory key={editing.id} routineId={editing.id} /> : null}
      {identityDialog}
      <ConfirmDialog
        open={leaving !== null}
        onCancel={() => setLeaving(null)}
        title={<Trans>Discard unsaved changes?</Trans>}
        confirmLabel={<Trans>Discard</Trans>}
        onConfirm={() => {
          const exit = leaving;
          setLeaving(null);
          exit?.();
        }}
      />
    </div>
  );
}
