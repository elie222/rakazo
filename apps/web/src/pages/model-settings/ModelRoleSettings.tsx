import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ModelBackupChoice,
  ModelCredential,
  ModelRole,
  ModelRoleChoice,
  ModelRoleSettings as ModelRoleSettingsValue,
  SettingsScope,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  connectedBackupOptions,
  MAX_MODEL_BACKUPS,
  modelConnectionNames,
  modelRoleChoiceKey,
} from "@rakazo/contracts";
import {
  catalogEntryFor,
  connectionForModelChoice,
  createModelRoleSettings,
  modelRoleListPatch,
  modelSettingsEditable,
  modelThinkingLevels,
  sameModelRoleChoice,
} from "@rakazo/core";
import { localizeModelEntry } from "@rakazo/i18n/model-provider";
import { thinkingLevelLabel } from "@rakazo/i18n/thinking-level";
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
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVertical, MoreHorizontal, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { spaceQueries } from "../../lib/query/query";
import { useSpaceRpc } from "../../lib/query/space-rpc";
import type { ConnectableProvider, RoleModelOption } from "./role-model-picker";
import { RoleModelPicker, rolePickerTrigger } from "./role-model-picker";

export type ModelRoleConnectIntent = {
  /** Only the main role's empty first slot takes the new connection's model on connect. */
  makeDefault: boolean;
  onConnected: (choice: ModelRoleChoice) => Promise<void>;
};

type Props = {
  userId: string;
  spaceId: string;
  /** The account's list, or the Space's own when it overrides models. */
  scope: SettingsScope;
  credentials: ModelCredential[];
  modelRole?: ModelRole;
  title: string;
  hideHeading?: boolean;
  /** What runs when the first slot is empty. */
  defaultLabel: string;
  providers: ConnectableProvider[];
  /** Connection-aware names, such as "Claude subscription" or a compatible server's host. */
  providerLabel: (provider: string) => string;
  onConnect: (provider: ConnectableProvider, intent: ModelRoleConnectIntent) => void;
  /** Opens one connection's dialog. */
  onManage: (provider: string, credentialId: string) => void;
  /** Opens one model's settings on the connection that runs it. */
  onManageModel?: (choice: { provider: string; modelId: string; credentialId: string }) => void;
  /** Offer effort for the first row when its model can think. */
  thinking?: boolean;
  onChanged?: () => void;
  /** The connection form, when it was opened from this list. */
  panel?: ReactNode;
  /** Sits at the end of the heading row. */
  headerAction?: ReactNode;
  /** Extra items in the first row's menu. */
  primaryMenuItems?: ReactNode;
};

let blankImage: HTMLImageElement | undefined;
const emptyDragImage = () => {
  blankImage ??= Object.assign(new Image(), {
    src: "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
  });
  return blankImage;
};

const choiceOf = (option: RoleModelOption): ModelRoleChoice => ({
  provider: option.provider,
  modelId: option.id,
  ...(option.creditOfferingId ? { creditOfferingId: option.creditOfferingId } : {}),
  ...(option.credentialId ? { credentialId: option.credentialId } : {}),
});

/** One role's saved list, read through the same cache entry its settings list keeps fresh. */
export function useModelRole(
  account: { userId: string; spaceId: string } | null,
  scope: SettingsScope,
  role: ModelRole,
) {
  const rpc = useSpaceRpc();
  const userId = account?.userId ?? "";
  const spaceId = account?.spaceId ?? "";
  const input = { role, expectedUserId: userId, scope };
  return useQuery({
    queryKey: spaceQueries(userId, spaceId).models.role.queryKey({ input }),
    queryFn: () => rpc.models.role(input, { context: { spaceId } }),
    enabled: Boolean(account),
  }).data;
}

/** One ordered list per model purpose: the first row runs, the rest take over in order. */
export function ModelRoleSettings({
  userId,
  spaceId,
  scope,
  credentials,
  modelRole: role = "main",
  title,
  hideHeading,
  defaultLabel,
  providers,
  providerLabel,
  onConnect,
  onManage,
  onManageModel,
  thinking,
  onChanged,
  panel,
  headerAction,
  primaryMenuItems,
}: Props) {
  const rpc = useSpaceRpc();
  const queryClient = useQueryClient();
  const { t } = useLingui();
  const controller = useMemo(() => {
    // The last load is cached per user, space, scope, and role, so a revisit shows it while
    // refreshing. Which models a role can use does not depend on the scope.
    const queries = spaceQueries(userId, spaceId);
    const catalogInput = { role, expectedUserId: userId };
    const input = { ...catalogInput, scope };
    const settingsKey = queries.models.role.queryKey({ input });
    const catalogKey = queries.models.forRole.queryKey({ input: catalogInput });
    const settings = queryClient.getQueryData(settingsKey);
    const catalog = queryClient.getQueryData(catalogKey);
    return createModelRoleSettings(
      {
        load: () =>
          queryClient.fetchQuery({
            queryKey: settingsKey,
            queryFn: () => rpc.models.role(input, { context: { spaceId } }),
            staleTime: 0,
          }),
        catalog: () =>
          queryClient.fetchQuery({
            queryKey: catalogKey,
            queryFn: () => rpc.models.forRole(catalogInput, { context: { spaceId } }),
            staleTime: 0,
          }),
        save: async (patch) => {
          const saved = await rpc.models.setRole({ ...input, ...patch }, { context: { spaceId } });
          queryClient.setQueryData(settingsKey, saved);
          return saved;
        },
      },
      JSON.stringify([window.location.origin, userId, spaceId, scope, role]),
      settings && catalog ? { settings, catalog } : undefined,
    );
  }, [queryClient, rpc, userId, spaceId, scope, role]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  // The list as it reads mid-drag: the dragged row moves through it, and the order saves on drop.
  const [drag, setDrag] = useState<{
    key: string;
    from: ModelRoleChoice[];
    order: ModelRoleChoice[];
  } | null>(null);
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
    catalogEntryFor(state.catalog, choice.provider, choice.modelId);
  // Grouped by the connection that runs them.
  const options: RoleModelOption[] = connectedBackupOptions(
    state.catalog.map(localizeModelEntry),
    credentials,
    role === "computer",
  ).map((choice) => ({
    ...(entryFor(choice) ?? {
      provider: choice.provider,
      id: choice.modelId,
      label: choice.label,
      billing: "",
    }),
    creditOfferingId: choice.creditOfferingId,
    providerName: choice.creditOfferingId ? t`Rakazo credits` : choice.connectionName,
    ...(choice.credentialId ? { credentialId: choice.credentialId } : {}),
  }));
  // A pinned row runs on its connection; others on the provider's newest.
  const connectionFor = (choice: ModelRoleChoice) => connectionForModelChoice(credentials, choice);
  const thinkingLevels =
    thinking && primary
      ? modelThinkingLevels(connectionFor(primary), entryFor(primary), primary.modelId).filter(
          (level) => level !== "off",
        )
      : [];
  const providerName = (choice: ModelRoleChoice) => {
    const named =
      (choice.creditOfferingId ? t`Rakazo credits` : undefined) ||
      (choice.credentialId &&
        options.find((option) => option.credentialId === choice.credentialId)?.providerName);
    if (named) return named;
    const entry = entryFor(choice);
    return entry?.managed
      ? modelConnectionNames(localizeModelEntry(entry)).providerName
      : providerLabel(choice.provider);
  };
  // What runs when the member chose no first model; named in the empty row and offered to
  // return to from the picker.
  const deployment = settings?.deploymentPrimary ?? null;
  // The deployment pays for its default, so it reads as included rather than as a provider bill.
  const deploymentSource = deployment
    ? settings?.deploymentIncluded
      ? t`Included`
      : providerName(deployment)
    : undefined;
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
  const commit = (next: ModelRoleChoice[]) => save((current) => modelRoleListPatch(current, next));
  const canMove = (index: number, target: number) =>
    target >= 0 && target < rows.length && target !== index;
  // A replaced row is found by its model in the loaded list, since a reload may reorder it.
  const place = (slot: ModelRoleChoice | "add", choice: ModelRoleChoice) =>
    save((current) => {
      const list = current.primary ? [current.primary, ...current.backups] : current.backups;
      // A pick made from rows that were still catching up may already be in the loaded
      // list; it keeps its place rather than moving and displacing the main model.
      if (list.some((item) => sameModelRoleChoice(item, choice))) return {};
      const at = slot === "add" ? -1 : list.findIndex((item) => sameModelRoleChoice(item, slot));
      return modelRoleListPatch(
        current,
        at < 0 ? [...list, choice] : list.map((item, index) => (index === at ? choice : item)),
      );
    });
  const setThinking = (level: ThinkingLevel | null) =>
    save((current) => ({
      primary: current.primary && { ...current.primary, thinkingLevel: level },
    }));
  const setPrimary = (choice: ModelRoleChoice | null) =>
    save((current) => ({
      primary: choice,
      backups: choice
        ? current.backups.filter((item) => !sameModelRoleChoice(item, choice))
        : current.backups,
    }));
  const move = (index: number, target: number) => {
    if (!canMove(index, target)) return;
    const next = [...rows];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    void commit(next);
  };
  // The pointer's half of the hovered row decides the side, so repeated events settle.
  const dragOver = (target: ModelRoleChoice, after: boolean) => {
    if (!drag || modelRoleChoiceKey(target) === drag.key) return;
    const order = drag.order.filter((item) => modelRoleChoiceKey(item) !== drag.key);
    const dragged = drag.order.find((item) => modelRoleChoiceKey(item) === drag.key)!;
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, dragged);
    if (order.some((item, index) => item !== drag.order[index])) setDrag({ ...drag, order });
  };
  // A drop over a list that reloaded mid-drag is dropped rather than saving the old rows.
  const drop = () => {
    const unchanged = (list: ModelRoleChoice[]) =>
      list.length === rows.length &&
      list.every((item, index) => sameModelRoleChoice(item, rows[index]!));
    if (drag && unchanged(drag.from) && !unchanged(drag.order)) void commit(drag.order);
    setDrag(null);
  };
  const remove = (index: number) => void commit(rows.filter((_, item) => item !== index));
  const connectFor = (slot: "primary" | number | "add") => (provider: ConnectableProvider) =>
    onConnect(provider, {
      makeDefault: role === "main" && slot === "primary" && !primary,
      onConnected: async (choice) => {
        await controller.load();
        onChanged?.();
        setReopen({ slot, query: providerName(choice), key: Date.now() });
      },
    });
  const reopenFor = (slot: "primary" | number | "add") =>
    reopen?.slot === slot ? { query: reopen.query, key: reopen.key } : undefined;

  const canAdd = (primary || deployment) && backups.length < MAX_MODEL_BACKUPS;
  // Order only means something once there is more than one row.
  const ordered = rows.length + (primary ? 0 : 1) > 1;
  const rowClass = `flex min-h-[52px] items-center gap-2.5 py-2 pe-2 ${ordered ? "ps-2" : "ps-3"}`;
  const number = (index: number) => (
    <span className="grid size-5 shrink-0 place-items-center rounded-md bg-accent text-label text-muted-foreground">
      {index + 1}
    </span>
  );

  const optionsLabel = (name: string) => t`${name} options`;

  return (
    <section className="mb-8" data-testid={`model-role-${role}`}>
      {hideHeading ? null : (
        <div className="mb-2.5 flex min-h-7 items-center justify-between gap-3">
          <SectionHeading variant="heading">{title}</SectionHeading>
          {headerAction}
        </div>
      )}
      <ol className="divide-y divide-border rounded-xl border border-border">
        {primary ? null : (
          <li className={`${rowClass} ${ordered ? "ps-8" : ""}`} data-testid="model-role-default">
            {ordered ? number(0) : null}
            <RoleModelPicker
              trigger={rolePickerTrigger(
                // Blank until loaded, so an unloaded role never reads as unconfigured.
                !settings ? "\u00a0" : deployment ? modelLabel(deployment) : defaultLabel,
                deploymentSource,
              )}
              label={hideHeading ? defaultLabel : t`Change ${title}`}
              options={options}
              current={deployment ?? undefined}
              providers={providers}
              disabled={pickerLocked}
              onPick={(option) => (option ? void setPrimary(choiceOf(option)) : null)}
              onConnect={connectFor("primary")}
              reopen={reopenFor("primary")}
              onReopened={() => setReopen(null)}
            />
            {deployment && primaryMenuItems ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground"
                      aria-label={optionsLabel(modelLabel(deployment))}
                      disabled={busy}
                    />
                  }
                >
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[200px]">
                  {primaryMenuItems}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </li>
        )}
        {(drag?.order ?? rows).map((choice, index) => {
          const dragged = drag?.key === modelRoleChoiceKey(choice);
          const isPrimary = Boolean(primary) && index === 0;
          const name = modelLabel(choice);
          const offset = primary ? 0 : 1;
          const connection = connectionFor(choice);
          return (
            <li
              key={modelRoleChoiceKey(choice)}
              className={`${rowClass} ${dragged ? "relative z-10 rounded-lg bg-card shadow-lg ring-1 ring-border" : ""}`}
              data-testid={`model-role-row-${index + offset + 1}`}
              draggable={rows.length > 1 && !busy}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                // The row itself moves through the list, so the browser's translucent copy is hidden.
                event.dataTransfer.setDragImage(emptyDragImage(), 0, 0);
                setDrag({ key: modelRoleChoiceKey(choice), from: rows, order: rows });
              }}
              onDragEnd={() => setDrag(null)}
              onDragOver={(event) => {
                if (!drag) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const box = event.currentTarget.getBoundingClientRect();
                dragOver(choice, event.clientY > box.top + box.height / 2);
              }}
              onDrop={(event) => {
                event.preventDefault();
                drop();
              }}
            >
              {ordered ? (
                <>
                  <GripVertical
                    aria-hidden
                    className={`size-3.5 shrink-0 text-muted-foreground/60 ${rows.length > 1 ? "cursor-grab" : "invisible"}`}
                  />
                  {number(index + offset)}
                </>
              ) : null}
              <RoleModelPicker
                trigger={rolePickerTrigger(name, providerName(choice))}
                label={t`Change ${name}`}
                options={options}
                current={choice}
                defaultOption={
                  isPrimary && role !== "main" && deployment
                    ? { label: modelLabel(deployment), included: settings?.deploymentIncluded }
                    : undefined
                }
                providers={providers}
                disabled={pickerLocked}
                onPick={(option) =>
                  option
                    ? void (isPrimary
                        ? setPrimary(choiceOf(option))
                        : place(choice, choiceOf(option)))
                    : void setPrimary(null)
                }
                onConnect={connectFor(isPrimary ? "primary" : index)}
                reopen={reopenFor(isPrimary ? "primary" : index)}
                onReopened={() => setReopen(null)}
              />
              {isPrimary && thinkingLevels.length && choice.thinkingLevel ? (
                <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-body-sm text-muted-foreground">
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
                      aria-label={optionsLabel(name)}
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
                  {isPrimary && primaryMenuItems ? (
                    <>
                      {primaryMenuItems}
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  {connection &&
                  onManageModel &&
                  modelSettingsEditable(connection, entryFor(choice), choice.modelId) ? (
                    <DropdownMenuItem
                      onClick={() =>
                        onManageModel({
                          provider: choice.provider,
                          modelId: choice.modelId,
                          credentialId: connection.id,
                        })
                      }
                    >
                      <Trans>Manage model</Trans>
                    </DropdownMenuItem>
                  ) : null}
                  {connection ? (
                    <DropdownMenuItem onClick={() => onManage(connection.provider, connection.id)}>
                      <Trans>Manage provider</Trans>
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
                  className="flex w-full items-center gap-2 rounded-b-xl px-3 py-3 text-start text-body text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <Plus className="size-4" aria-hidden />
                  <Trans>Add fallback</Trans>
                </button>
              }
              label={t`Add fallback`}
              options={options.filter((option) =>
                rows.every((row) => !sameModelRoleChoice(row, choiceOf(option))),
              )}
              providers={providers}
              disabled={pickerLocked}
              onPick={(option) => (option ? void place("add", choiceOf(option)) : null)}
              onConnect={connectFor("add")}
              reopen={reopenFor("add")}
              onReopened={() => setReopen(null)}
            />
          </li>
        ) : null}
      </ol>
      {panel}
      {state.error ? (
        <div role="alert" className="mt-2 text-body text-destructive">
          {state.error}
          <Button variant="ghost" disabled={state.busy} onClick={() => void controller.load()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
