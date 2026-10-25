import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ModelBackupChoice,
  ModelCatalogEntry,
  ModelCredential,
  ModelRole,
  ModelRoleSettings as ModelRoleSettingsValue,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  backupChoiceKey,
  canonicalPiProviderId,
  connectedBackupOptions,
  MAX_MODEL_BACKUPS,
} from "@rakazo/contracts";
import { createModelRoleSettings } from "@rakazo/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Spinner,
} from "@rakazo/ui-web";
import { GripVertical, MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { thinkingLevelLabel } from "../lib/model-catalog";
import { useSpaceRpc } from "../lib/space-rpc";
import type { ConnectableProvider } from "./model-settings/role-model-picker";
import { RoleModelPicker } from "./model-settings/role-model-picker";

export type ModelRoleConnectIntent = {
  /** Only the main role's empty first slot takes the new connection's model on connect. */
  makeDefault: boolean;
  onConnected: (choice: ModelBackupChoice) => Promise<void>;
};

type Props = {
  userId: string;
  spaceId: string;
  credentials: ModelCredential[];
  modelRole?: ModelRole;
  title: string;
  /** What runs when the first slot is empty. */
  defaultLabel: string;
  providers: ConnectableProvider[];
  /** Connection-aware names, such as "Claude subscription" or a compatible server's host. */
  providerLabel: (provider: string) => string;
  onConnect: (provider: ConnectableProvider, intent: ModelRoleConnectIntent) => void;
  onManage: (provider: string) => void;
  /** Offer effort for the first row when its model can think. */
  thinking?: boolean;
  onChanged?: () => void;
};

const sameChoice = (left: ModelBackupChoice, right: ModelBackupChoice) =>
  backupChoiceKey(left) === backupChoiceKey(right);

/** One ordered list per model purpose: the first row runs, the rest take over in order. */
export function ModelRoleSettings({
  userId,
  spaceId,
  credentials,
  modelRole: role = "main",
  title,
  defaultLabel,
  providers,
  providerLabel,
  onConnect,
  onManage,
  thinking,
  onChanged,
}: Props) {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const controller = useMemo(
    () =>
      createModelRoleSettings(
        {
          load: () => rpc.models.role({ role, expectedUserId: userId }, { context: { spaceId } }),
          catalog: () =>
            rpc.models.forRole({ role, expectedUserId: userId }, { context: { spaceId } }),
          save: (patch) =>
            rpc.models.setRole(
              { role, expectedUserId: userId, ...patch },
              { context: { spaceId } },
            ),
        },
        JSON.stringify([window.location.origin, userId, spaceId, role]),
      ),
    [rpc, userId, spaceId, role],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [dragging, setDragging] = useState<number | null>(null);
  // After a connection the slot's picker reopens on that provider's models.
  const [reopen, setReopen] = useState<{
    slot: "primary" | number | "add";
    query: string;
    key: number;
  } | null>(null);
  useEffect(() => {
    void controller.load();
  }, [controller, credentials]);

  const settings = state.settings;
  const primary = settings?.primary ?? null;
  const backups = settings?.backups ?? [];
  const rows = primary ? [primary, ...backups] : backups;
  const entryFor = (choice: ModelBackupChoice) =>
    state.catalog.find(
      (entry) =>
        canonicalPiProviderId(entry.provider) === canonicalPiProviderId(choice.provider) &&
        entry.id === choice.modelId,
    );
  const connected = new Set(credentials.map((entry) => canonicalPiProviderId(entry.provider)));
  const thinkingLevels =
    thinking && primary
      ? (entryFor(primary)?.thinkingLevels ?? []).filter((level) => level !== "off")
      : [];
  const options: ModelCatalogEntry[] = connectedBackupOptions(state.catalog, credentials).map(
    (choice) => ({
      ...(entryFor(choice) ?? {
        provider: choice.provider,
        id: choice.modelId,
        label: choice.label,
        billing: "",
      }),
      providerName: providerLabel(choice.provider),
    }),
  );
  const providerName = (choice: ModelBackupChoice) => providerLabel(choice.provider);
  const modelLabel = (choice: ModelBackupChoice) => entryFor(choice)?.label ?? choice.modelId;
  const busy = state.busy || state.stale || !settings;
  // Picks build their change from the settings loaded when they save, so a reload in flight
  // does not lock them; moves and removals use the rows on screen and wait for it.
  const pickerLocked = state.stale || !settings;

  async function save(
    update: (current: ModelRoleSettingsValue) => Partial<ModelRoleSettingsValue>,
  ) {
    await controller.save(update);
    onChanged?.();
  }
  // The first row is the primary; moving a fallback there promotes it. When the primary
  // goes, the next fallback takes over, or the deployment's default runs.
  const commit = (next: ModelBackupChoice[]) => save((current) => listPatch(current, next));
  const canMove = (index: number, target: number) =>
    target >= 0 && target < rows.length && target !== index;
  // A replaced row is found by its model in the loaded list, since a reload may reorder it.
  const place = (slot: ModelBackupChoice | "add", choice: ModelBackupChoice) =>
    save((current) => {
      const list = current.primary ? [current.primary, ...current.backups] : current.backups;
      // A pick made from rows that were still catching up may already be in the loaded
      // list; it keeps its place rather than moving and displacing the main model.
      if (list.some((item) => sameChoice(item, choice))) return {};
      const at = slot === "add" ? -1 : list.findIndex((item) => sameChoice(item, slot));
      return listPatch(
        current,
        at < 0 ? [...list, choice] : list.map((item, index) => (index === at ? choice : item)),
      );
    });
  const setThinking = (level: ThinkingLevel | null) =>
    save((current) => ({
      primary: current.primary && { ...current.primary, thinkingLevel: level },
    }));
  const setPrimary = (choice: ModelBackupChoice | null) =>
    save((current) => ({
      primary: choice,
      backups: choice
        ? current.backups.filter((item) => !sameChoice(item, choice))
        : current.backups,
    }));
  const move = (index: number, target: number) => {
    if (!canMove(index, target)) return;
    const next = [...rows];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    void commit(next);
  };
  const remove = (index: number) => void commit(rows.filter((_, item) => item !== index));
  const connectFor = (slot: "primary" | number | "add") => (provider: ConnectableProvider) =>
    onConnect(provider, {
      makeDefault: role === "main" && slot === "primary" && !primary,
      onConnected: async (choice) => {
        await controller.load();
        onChanged?.();
        setReopen({ slot, query: providerLabel(choice.provider), key: Date.now() });
      },
    });
  const reopenFor = (slot: "primary" | number | "add") =>
    reopen?.slot === slot ? { query: reopen.query, key: reopen.key } : undefined;

  const canAdd = backups.length < MAX_MODEL_BACKUPS;
  const rowClass = "flex min-h-[52px] items-center gap-2.5 py-2 ps-2 pe-2";
  const number = (index: number) => (
    <span className="grid size-5 shrink-0 place-items-center rounded-md bg-muted text-[12px] text-muted-foreground">
      {index + 1}
    </span>
  );
  const pickerTrigger = (label: string, sub?: string) => (
    <button
      type="button"
      className="flex min-w-0 flex-1 items-baseline gap-1.5 rounded-md py-1 text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span className="truncate text-[15px] text-foreground">{label}</span>
      {sub ? <span className="truncate text-[13px] text-muted-foreground">· {sub}</span> : null}
    </button>
  );

  return (
    <section className="mb-8" data-testid={`model-role-${role}`}>
      <h3 className="mb-2.5 text-heading3 font-medium text-foreground">{title}</h3>
      <ol className="divide-y divide-border rounded-xl border border-border">
        {primary ? null : (
          <li className={`${rowClass} ps-8`} data-testid="model-role-default">
            {number(0)}
            <RoleModelPicker
              trigger={pickerTrigger(defaultLabel)}
              label={t`Change ${title}`}
              options={options}
              defaultOption={role === "main" ? undefined : defaultLabel}
              providers={providers}
              disabled={pickerLocked}
              onPick={(option) =>
                option ? void setPrimary({ provider: option.provider, modelId: option.id }) : null
              }
              onConnect={connectFor("primary")}
              reopen={reopenFor("primary")}
              onReopened={() => setReopen(null)}
            />
          </li>
        )}
        {rows.map((choice, index) => {
          const isPrimary = Boolean(primary) && index === 0;
          const name = modelLabel(choice);
          const offset = primary ? 0 : 1;
          const manageable = connected.has(canonicalPiProviderId(choice.provider));
          return (
            <li
              key={backupChoiceKey(choice)}
              className={`${rowClass} ${dragging === index ? "opacity-50" : ""}`}
              data-testid={`model-role-row-${index + offset + 1}`}
              draggable={rows.length > 1 && !busy}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                setDragging(index);
              }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => {
                if (dragging !== null) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== null) move(dragging, index);
                setDragging(null);
              }}
            >
              <GripVertical
                aria-hidden
                className={`size-3.5 shrink-0 text-muted-foreground/60 ${rows.length > 1 ? "cursor-grab" : "invisible"}`}
              />
              {number(index + offset)}
              <RoleModelPicker
                trigger={pickerTrigger(name, providerName(choice))}
                label={t`Change ${name}`}
                options={options}
                defaultOption={isPrimary && role !== "main" ? defaultLabel : undefined}
                providers={providers}
                disabled={pickerLocked}
                onPick={(option) =>
                  option
                    ? void (isPrimary
                        ? setPrimary({ provider: option.provider, modelId: option.id })
                        : place(choice, { provider: option.provider, modelId: option.id }))
                    : void setPrimary(null)
                }
                onConnect={connectFor(isPrimary ? "primary" : index)}
                reopen={reopenFor(isPrimary ? "primary" : index)}
                onReopened={() => setReopen(null)}
              />
              {isPrimary && thinkingLevels.length && choice.thinkingLevel ? (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[12.5px] text-muted-foreground">
                  <Trans>Thinking: {thinkingLevelLabel(choice.thinkingLevel)}</Trans>
                </span>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground"
                      aria-label={t`${name} options`}
                      disabled={busy}
                    />
                  }
                >
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[200px]">
                  {isPrimary && thinkingLevels.length ? (
                    <>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <Trans>Thinking</Trans>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuRadioGroup
                            value={choice.thinkingLevel ?? ""}
                            onValueChange={(value) =>
                              void setThinking((value || null) as ThinkingLevel | null)
                            }
                          >
                            <DropdownMenuRadioItem value="">
                              <Trans>Default</Trans>
                            </DropdownMenuRadioItem>
                            {thinkingLevels.map((level) => (
                              <DropdownMenuRadioItem key={level} value={level}>
                                {thinkingLevelLabel(level)}
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  {rows.length > 1 ? (
                    <>
                      <DropdownMenuItem
                        disabled={!canMove(index, index - 1)}
                        onClick={() => move(index, index - 1)}
                      >
                        <Trans>Move up</Trans>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!canMove(index, index + 1)}
                        onClick={() => move(index, index + 1)}
                      >
                        <Trans>Move down</Trans>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  {manageable ? (
                    <DropdownMenuItem onClick={() => onManage(choice.provider)}>
                      <Trans>Manage {providerName(choice)}</Trans>
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem variant="destructive" onClick={() => remove(index)}>
                    <Trans>Remove</Trans>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
        {canAdd ? (
          <li>
            <RoleModelPicker
              trigger={
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-b-xl px-3 py-3 text-start text-[14px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <Plus className="size-4" aria-hidden />
                  <Trans>Add fallback</Trans>
                </button>
              }
              label={t`Add fallback`}
              options={options.filter((option) =>
                rows.every(
                  (row) => !sameChoice(row, { provider: option.provider, modelId: option.id }),
                ),
              )}
              providers={providers}
              disabled={pickerLocked}
              onPick={(option) =>
                option ? void place("add", { provider: option.provider, modelId: option.id }) : null
              }
              onConnect={connectFor("add")}
              reopen={reopenFor("add")}
              onReopened={() => setReopen(null)}
            />
          </li>
        ) : null}
      </ol>
      {state.busy && !settings ? (
        <Spinner className="mt-3" aria-label={t`Loading model catalog…`} />
      ) : null}
      {state.error ? (
        <div role="alert" className="mt-2 text-sm text-destructive">
          {state.error}
          <Button variant="ghost" disabled={state.busy} onClick={() => void controller.load()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function listPatch(
  current: ModelRoleSettingsValue,
  list: ModelBackupChoice[],
): Partial<ModelRoleSettingsValue> {
  return current.primary ? { primary: list[0] ?? null, backups: list.slice(1) } : { backups: list };
}
