import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ConnectedBackupOption,
  Me,
  ModelBackupChoice,
  ModelCatalogEntry,
  ModelCredential,
} from "@rakazo/contracts";
import {
  backupChoiceKey,
  connectedBackupOptions,
  MAX_MODEL_BACKUPS,
  moveBackupChoice,
  sameBackupChoices,
} from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { providerDisplayName } from "../lib/localized-provider-hint";
import { selectedSpaceId } from "../lib/rpc";
import { useBoundSpaceId, useSpaceRpc } from "../lib/space-rpc";

type Scope = { userId: string; spaceId: string };
type BackupsState = {
  scopeKey: string;
  loading: boolean;
  ready: boolean;
  backups: ModelBackupChoice[];
  error: string | null;
};

function scopeKey(scope: Scope): string {
  return JSON.stringify([scope.userId, scope.spaceId]);
}

/**
 * Saves still in flight per account and space. They outlive the component, so an edit made just
 * before leaving Models still reaches the server, and reopening Models waits for them before
 * loading the list.
 */
const pendingSaves = new Map<string, Promise<void>>();

function loadingState(key: string): BackupsState {
  return { scopeKey: key, loading: true, ready: false, backups: [], error: null };
}

/** Backups load and save only while the space they belong to is the one settings act on. */
function isSelectedSpace(spaceId: string, boundSpaceId: string | null): boolean {
  if (boundSpaceId) return boundSpaceId === spaceId;
  const selected = selectedSpaceId();
  return selected === null || selected === spaceId;
}

export function ModelBackupsSettings({
  userId,
  spaceId,
  catalog,
  credentials,
}: Scope & { catalog: ModelCatalogEntry[]; credentials: ModelCredential[] }) {
  const rpc = useSpaceRpc();
  const boundSpaceId = useBoundSpaceId();
  const { t } = useLingui();
  const activeScopeKey = scopeKey({ userId, spaceId });
  const activeScopeRef = useRef(activeScopeKey);
  activeScopeRef.current = activeScopeKey;
  const requestGenerationRef = useRef(0);
  // The last list the server confirmed; a failed save reverts to it.
  const confirmedRef = useRef<ModelBackupChoice[]>([]);
  // Bumped on a failed save so edits queued behind it are dropped with the revert.
  const saveEpochRef = useRef(0);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [state, setState] = useState<BackupsState>(() => loadingState(activeScopeKey));
  const options = useMemo(
    () =>
      connectedBackupOptions(catalog, credentials).map((option) => ({
        ...option,
        providerName: providerDisplayName(
          option.provider,
          option.providerName,
          credentials.find((credential) => credential.provider === option.provider)?.authKind,
        ),
      })),
    [catalog, credentials],
  );
  const optionByKey = useMemo(
    () => new Map(options.map((option) => [backupChoiceKey(option), option])),
    [options],
  );
  const currentState = state.scopeKey === activeScopeKey ? state : null;
  const selectedSpaceMatches = isSelectedSpace(spaceId, boundSpaceId);
  const backups = currentState?.backups ?? [];
  const backupKeys = new Set(backups.map(backupChoiceKey));
  const addableOptions = options.filter((option) => !backupKeys.has(backupChoiceKey(option)));
  const editable = Boolean(currentState?.ready && !currentState.loading && selectedSpaceMatches);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled &&
      generation === requestGenerationRef.current &&
      activeScopeRef.current === activeScopeKey &&
      isSelectedSpace(spaceId, boundSpaceId);
    confirmedRef.current = [];
    setState(loadingState(activeScopeKey));
    void (async () => {
      try {
        if (!isSelectedSpace(spaceId, boundSpaceId)) {
          throw new Error(t`Space changed. Reopen Models to load its backup list.`);
        }
        await pendingSaves.get(activeScopeKey);
        const currentMe = (await rpc.me({ context: { spaceId } })) as Me;
        if (currentMe.userId !== userId || currentMe.spaceId !== spaceId || !isCurrent()) {
          throw new Error(t`Space changed. Reopen Models to load its backup list.`);
        }
        const saved = await rpc.models.backups({}, { context: { spaceId } });
        if (!isCurrent()) return;
        confirmedRef.current = [...saved];
        setState({
          scopeKey: activeScopeKey,
          loading: false,
          ready: true,
          backups: [...saved],
          error: null,
        });
      } catch (error) {
        if (!isCurrent()) return;
        setState((previous) =>
          previous.scopeKey === activeScopeKey
            ? {
                ...previous,
                loading: false,
                ready: false,
                error: error instanceof Error ? error.message : t`Could not load backup models`,
              }
            : previous,
        );
      }
    })();
    return () => {
      cancelled = true;
      if (requestGenerationRef.current === generation) requestGenerationRef.current += 1;
    };
  }, [activeScopeKey, reloadNonce, spaceId, t, userId]);

  // Writes go to the account and space the edit was made in, even after leaving Models; only
  // the on-screen state stops following once the view moves on.
  async function persist(choices: ModelBackupChoice[], onScreen: () => boolean) {
    try {
      const currentMe = (await rpc.me({ context: { spaceId } })) as Me;
      if (currentMe.userId !== userId || currentMe.spaceId !== spaceId) {
        throw new Error(t`Space changed. Reopen Models to save its backup list.`);
      }
      await rpc.models.setBackups(choices, { context: { spaceId } });
      if (onScreen()) confirmedRef.current = choices;
    } catch (error) {
      saveEpochRef.current += 1;
      if (!onScreen()) return;
      const confirmed = confirmedRef.current;
      setState((previous) =>
        previous.scopeKey === activeScopeKey
          ? {
              ...previous,
              backups: confirmed,
              error: error instanceof Error ? error.message : t`Could not save backup models`,
            }
          : previous,
      );
    }
  }

  function update(next: (backups: ModelBackupChoice[]) => ModelBackupChoice[]) {
    if (!currentState || !editable) return;
    const choices = next(currentState.backups).map((choice) => ({ ...choice }));
    if (choices.length > MAX_MODEL_BACKUPS || sameBackupChoices(choices, currentState.backups)) {
      return;
    }
    const generation = requestGenerationRef.current;
    const epoch = saveEpochRef.current;
    const onScreen = () =>
      generation === requestGenerationRef.current &&
      activeScopeRef.current === activeScopeKey &&
      isSelectedSpace(spaceId, boundSpaceId);
    setState((previous) =>
      previous.scopeKey === activeScopeKey
        ? { ...previous, backups: choices, error: null }
        : previous,
    );
    // Saves run one at a time so the server ends at the latest list; a failed save drops the
    // edits queued behind it along with the revert.
    const chain = (pendingSaves.get(activeScopeKey) ?? Promise.resolve()).then(() =>
      epoch === saveEpochRef.current ? persist(choices, onScreen) : undefined,
    );
    pendingSaves.set(activeScopeKey, chain);
    void chain.then(() => {
      if (pendingSaves.get(activeScopeKey) === chain) pendingSaves.delete(activeScopeKey);
    });
  }

  function add(option: ConnectedBackupOption) {
    update((list) =>
      list.some((choice) => backupChoiceKey(choice) === backupChoiceKey(option))
        ? list
        : [...list, { provider: option.provider, modelId: option.modelId }],
    );
  }

  const rowLabel = (choice: ModelBackupChoice) => {
    const option = optionByKey.get(backupChoiceKey(choice));
    const entry = catalog.find(
      (candidate) => candidate.provider === choice.provider && candidate.id === choice.modelId,
    );
    const providerName = option?.providerName ?? entry?.providerName ?? choice.provider;
    const label = option?.label ?? entry?.label ?? choice.modelId;
    return { full: `${providerName} · ${label}`, available: Boolean(option) };
  };

  const groups = new Map<string, ConnectedBackupOption[]>();
  for (const option of addableOptions) {
    groups.set(option.providerName, [...(groups.get(option.providerName) ?? []), option]);
  }
  const canAdd =
    Boolean(currentState?.ready) && backups.length < MAX_MODEL_BACKUPS && addableOptions.length > 0;

  if (
    !currentState ||
    currentState.loading ||
    (currentState.ready && backups.length === 0 && !canAdd && !currentState.error)
  ) {
    return null;
  }

  return (
    <section
      data-testid="model-backups"
      aria-labelledby="model-backups-title"
      className="mt-6 border-t border-border pt-5"
    >
      <h3 id="model-backups-title" className="text-[13.5px] text-muted-foreground">
        <Trans>Backup models</Trans>
      </h3>
      <p className="mt-1 text-[13px] leading-[1.5] text-muted-foreground">
        <Trans>Tried in order if the active model fails.</Trans>
      </p>
      {backups.length > 0 ? (
        <ol className="mt-3 divide-y divide-border rounded-xl border border-border">
          {backups.map((choice, index) => {
            const { full, available } = rowLabel(choice);
            return (
              <li
                key={backupChoiceKey(choice)}
                className="flex items-center gap-3 py-2 ps-3 pe-2"
                data-testid={`model-backup-${index + 1}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-foreground">{full}</span>
                  {!available ? (
                    <span className="block text-[13px] leading-[1.5] text-muted-foreground">
                      <Trans>Not connected</Trans>
                    </span>
                  ) : null}
                </span>
                <div className="flex shrink-0 items-center text-muted-foreground">
                  {backups.length > 1 ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t`Move ${full} up`}
                        disabled={index === 0 || !editable}
                        onClick={() => update((list) => moveBackupChoice(list, index, -1))}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t`Move ${full} down`}
                        disabled={index === backups.length - 1 || !editable}
                        onClick={() => update((list) => moveBackupChoice(list, index, 1))}
                      >
                        <ArrowDown />
                      </Button>
                    </>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t`Remove ${full}`}
                    disabled={!editable}
                    onClick={() => update((list) => list.filter((_, item) => item !== index))}
                  >
                    <X />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
      {canAdd ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={!editable}
            render={<Button type="button" variant="outline" className="mt-3" />}
          >
            <Plus data-icon="inline-start" />
            <Trans>Add backup model</Trans>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="max-h-80 w-auto min-w-56">
            {[...groups].map(([providerName, group]) => (
              <DropdownMenuGroup key={providerName}>
                {groups.size > 1 ? <DropdownMenuLabel>{providerName}</DropdownMenuLabel> : null}
                {group.map((option) => (
                  <DropdownMenuItem key={backupChoiceKey(option)} onClick={() => add(option)}>
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {currentState.error ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive" role="alert">
            {currentState.error}
          </p>
          {!currentState.ready ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!selectedSpaceMatches}
              onClick={() => setReloadNonce((value) => value + 1)}
            >
              <Trans>Retry</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
