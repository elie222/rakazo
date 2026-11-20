import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ModelCredential,
  ModelRole,
  ModelRoleChoice,
  SettingsScope,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  connectedBackupOptions,
  MAX_MODEL_BACKUPS,
  modelRoleChoiceKey,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { createAccountModelRole } from "@rakazo/core";
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
  Spinner,
} from "@rakazo/ui-web";
import { useQueryClient } from "@tanstack/react-query";
import { GripVertical, MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { thinkingLevelLabel } from "../../lib/models/model-catalog";
import { spaceQueries } from "../../lib/query/query";
import { useSpaceRpc } from "../../lib/query/space-rpc";
import type { RoleModelOption } from "../model-settings/role-model-picker";
import { RoleModelPicker } from "../model-settings/role-model-picker";

export function AccountModelRoleSettings({
  userId,
  spaceId,
  scope,
  credentials,
  modelRole: role = "main",
  title,
  defaultLabel,
  thinking,
  onChanged,
}: {
  userId: string;
  spaceId: string;
  scope: SettingsScope;
  credentials: ModelCredential[];
  modelRole?: ModelRole;
  title: string;
  defaultLabel: string;
  thinking?: boolean;
  onChanged?: () => void;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const client = useQueryClient();
  const controller = useMemo(() => {
    const queries = spaceQueries(userId, spaceId);
    const target = { role, expectedUserId: userId };
    const input = { ...target, scope };
    return createAccountModelRole(
      {
        load: () =>
          client.fetchQuery({
            queryKey: queries.models.role.queryKey({ input }),
            queryFn: () => rpc.models.role(input, { context: { spaceId } }),
            staleTime: 0,
          }),
        catalog: () =>
          client.fetchQuery({
            queryKey: queries.models.forRole.queryKey({ input: target }),
            queryFn: () => rpc.models.forRole(target, { context: { spaceId } }),
            staleTime: 0,
          }),
        save: async (patch) => {
          const saved = await rpc.models.setRole({ ...input, ...patch }, { context: { spaceId } });
          client.setQueryData(queries.models.role.queryKey({ input }), saved);
          return saved;
        },
      },
      JSON.stringify([window.location.origin, userId, spaceId, scope, role]),
    );
  }, [client, rpc, userId, spaceId, scope, role]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => {
    void controller.load();
  }, [controller, credentials]);
  const [dragging, setDragging] = useState<ModelRoleChoice | null>(null);
  const settings = state.settings;
  const primary = settings?.primary;
  const rows = primary ? [primary, ...settings.backups] : (settings?.backups ?? []);
  const options: RoleModelOption[] = connectedBackupOptions(
    state.catalog.filter((entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID),
    credentials,
  ).map((choice) => ({
    ...(state.catalog.find(
      (entry) => entry.provider === choice.provider && entry.id === choice.modelId,
    ) ?? { provider: choice.provider, id: choice.modelId, label: choice.label, billing: "" }),
    providerName: choice.connectionName,
    credentialId: choice.credentialId,
  }));
  const name = (choice: ModelRoleChoice) =>
    options.find(
      (option) => option.id === choice.modelId && option.credentialId === choice.credentialId,
    )?.label ?? choice.modelId;
  const picked = (option: RoleModelOption | null): ModelRoleChoice | null =>
    option && {
      provider: option.provider,
      modelId: option.id,
      credentialId: option.credentialId,
    };
  const changed = async (save: Promise<void>) => {
    await save;
    onChanged?.();
  };
  const busy = state.busy || state.stale || !settings;
  const changeLabel = (name: string) => t`Change ${name}`;
  const optionsLabel = (name: string) => t`${name} options`;
  const picker = (slot: ModelRoleChoice | "add" | "primary", label: string, isPrimary = false) => (
    <RoleModelPicker
      trigger={
        <Button variant="ghost" className="min-w-0 flex-1 justify-start truncate">
          {label}
        </Button>
      }
      label={slot === "add" ? t`Add fallback` : changeLabel(label)}
      options={
        slot === "add"
          ? options.filter(
              (option) =>
                !rows.some(
                  (row) => modelRoleChoiceKey(row) === modelRoleChoiceKey(picked(option)!),
                ),
            )
          : options
      }
      providers={[]}
      onConnect={() => undefined}
      defaultOption={
        isPrimary && role !== "main" && settings?.deploymentPrimary
          ? name(settings.deploymentPrimary)
          : undefined
      }
      disabled={busy}
      onPick={(option) => void changed(controller.select(slot, picked(option)))}
    />
  );
  const levels =
    thinking && primary
      ? (
          state.catalog.find(
            (entry) => entry.provider === primary.provider && entry.id === primary.modelId,
          )?.thinkingLevels ?? []
        ).filter((level) => level !== "off")
      : [];
  return (
    <section className="mb-8" data-testid={`model-role-${role}`}>
      <SectionHeading>{title}</SectionHeading>
      <ol className="divide-y divide-border rounded-xl border border-border">
        {primary ? null : (
          <li className="flex p-2" data-testid="model-role-default">
            {picker(
              "primary",
              settings?.deploymentPrimary ? name(settings.deploymentPrimary) : defaultLabel,
            )}
          </li>
        )}
        {rows.map((choice, index) => (
          <li
            key={modelRoleChoiceKey(choice)}
            data-testid={`model-role-row-${index + (primary ? 1 : 2)}`}
            className="flex items-center gap-2 p-2"
            draggable={rows.length > 1 && !busy}
            onDragStart={() => setDragging(choice)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => {
              if (dragging) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging) {
                const from = rows.findIndex(
                  (row) => modelRoleChoiceKey(row) === modelRoleChoiceKey(dragging),
                );
                if (from >= 0) void changed(controller.move(dragging, index - from));
              }
              setDragging(null);
            }}
          >
            {rows.length > 1 ? (
              <GripVertical aria-hidden className="size-4 text-muted-foreground" />
            ) : null}
            {picker(
              primary && index === 0 ? "primary" : choice,
              name(choice),
              Boolean(primary && index === 0),
            )}
            {primary && index === 0 && choice.thinkingLevel && levels.length ? (
              <span className="text-body text-muted-foreground">
                {thinkingLevelLabel(choice.thinkingLevel)}
              </span>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    aria-label={optionsLabel(name(choice))}
                  />
                }
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {primary && index === 0 && levels.length ? (
                  <>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Trans>Thinking</Trans>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <DropdownMenuRadioGroup
                          value={choice.thinkingLevel ?? ""}
                          onValueChange={(level) =>
                            void changed(
                              controller.thinking((level || null) as ThinkingLevel | null),
                            )
                          }
                        >
                          <DropdownMenuRadioItem value="">
                            <Trans>Default</Trans>
                          </DropdownMenuRadioItem>
                          {levels.map((level) => (
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
                      disabled={index === 0}
                      onClick={() => void changed(controller.move(choice, -1))}
                    >
                      <Trans>Move up</Trans>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={index === rows.length - 1}
                      onClick={() => void changed(controller.move(choice, 1))}
                    >
                      <Trans>Move down</Trans>
                    </DropdownMenuItem>
                  </>
                ) : null}
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => void changed(controller.remove(choice))}
                >
                  <Trans>Remove</Trans>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
        {settings && settings.backups.length < MAX_MODEL_BACKUPS ? (
          <li className="flex p-2">
            <Plus className="size-4 self-center text-muted-foreground" />
            {picker("add", t`Add fallback`)}
          </li>
        ) : null}
      </ol>
      {state.busy && !settings ? <Spinner aria-label={t`Loading model catalog…`} /> : null}
      {state.error ? (
        <div role="alert" className="text-body text-destructive">
          {state.error}
          <Button variant="ghost" disabled={state.busy} onClick={() => void controller.load()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
