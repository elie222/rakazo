import { useLingui } from "@lingui/react/macro";
import type { SpaceSetting } from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import { Button } from "@rakazo/ui-web";
import type { QueryKey } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ApprovalRulesSettings } from "../../components/settings/ApprovalRulesSettings";
import { SettingsGroup, SettingsRow } from "../../components/settings/SettingsRows";
import { VaultSettings } from "../../components/vault/VaultSettings";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { ModelSettingsOverlay } from "../model-settings/ModelSettingsOverlay";
import { VoiceSettingsOverlay } from "./VoiceSettingsOverlay";

/**
 * Account settings the bound Space follows until the member customizes them here. A customized
 * setting shows the same panel as the account's section, editing the Space's own copy.
 */
export function SpaceSettingOverrides({
  onClose,
  onBusyChange,
}: {
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const overrides = useQuery(queries.spaceSettings.overrides.queryOptions());
  const [confirmingReset, setConfirmingReset] = useState<SpaceSetting | null>(null);
  const affectedReads: Record<SpaceSetting, QueryKey[]> = {
    models: [queries.models.key(), queries.me.key()],
    voice: [queries.voice.key()],
    confirmations: [queries.approvalRules.key(), queries.autoReview.key()],
    credentials: [queries.vault.key()],
  };
  const override = useSave({
    save: async ({ setting, enabled }: { setting: SpaceSetting; enabled: boolean }, rpc) => {
      const next = await rpc.spaceSettings.setOverride({ setting, enabled });
      await writeSaved(queryClient, queries.spaceSettings.overrides.queryKey(), () => next);
    },
    // Reads that omit a scope get whichever copy applies, so they change with the override.
    stale: ({ setting }) => affectedReads[setting],
    onSaved: () => setConfirmingReset(null),
    onFailed: () => setConfirmingReset(null),
  });
  // A credential still saving would land in the vault a reset is deleting.
  const [vaultBusy, setVaultBusy] = useState(false);

  const settings: {
    id: SpaceSetting;
    label: string;
    panel: () => ReactNode;
    resetConfirmation?: string;
    busy?: boolean;
  }[] = [
    {
      id: "models",
      label: t`Models`,
      panel: () => <ModelSettingsOverlay embedded scope="space" onClose={onClose} />,
    },
    {
      id: "voice",
      label: t`Voice`,
      panel: () => (
        <VoiceSettingsOverlay
          embedded
          scope="space"
          onClose={onClose}
          onBusyChange={onBusyChange}
        />
      ),
    },
    {
      id: "confirmations",
      label: t`Approvals`,
      panel: () => <ApprovalRulesSettings scope="space" />,
    },
    {
      id: "credentials",
      label: t`Vault`,
      panel: () => <VaultSettings scope="space" onBusyChange={setVaultBusy} />,
      busy: vaultBusy,
      // Going back to the defaults deletes the Space's own credentials.
      resetConfirmation: t`Delete this Space's credentials?`,
    },
  ];

  if (overrides.data === undefined) {
    return overrides.isError ? (
      <div role="alert" className="text-body-sm text-destructive">
        {errorText(overrides.error)}
        <Button variant="ghost" size="sm" onClick={() => void overrides.refetch()}>
          {t`Retry`}
        </Button>
      </div>
    ) : null;
  }
  const customized = overrides.data;
  const confirmTitle = settings.find(({ id }) => id === confirmingReset)?.resetConfirmation;

  return (
    <div className="space-y-3">
      <SettingsGroup data-testid="space-setting-overrides">
        {settings.map(({ id, label, panel, resetConfirmation, busy }) => {
          const custom = customized.includes(id);
          return (
            <div key={id} data-testid={`space-setting-${id}`}>
              <SettingsRow
                label={
                  <>
                    <p>{label}</p>
                    {custom ? null : (
                      <p className="text-body-sm text-muted-foreground">{t`Your defaults`}</p>
                    )}
                  </>
                }
                control={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-full"
                    aria-label={custom ? t`Use defaults for ${label}` : t`Customize ${label}`}
                    disabled={override.pending || busy}
                    onClick={() =>
                      custom && resetConfirmation
                        ? setConfirmingReset(id)
                        : override.run({ setting: id, enabled: !custom })
                    }
                  >
                    {custom ? t`Use defaults` : t`Customize`}
                  </Button>
                }
              >
                {custom ? <div className="pt-3">{panel()}</div> : null}
              </SettingsRow>
            </div>
          );
        })}
      </SettingsGroup>
      {override.error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {errorText(override.error)}
        </p>
      ) : null}
      {confirmingReset && confirmTitle ? (
        <ConfirmDialog
          onCancel={() => setConfirmingReset(null)}
          title={confirmTitle}
          description={t`This can't be undone.`}
          busy={override.pending}
          onConfirm={() => override.run({ setting: confirmingReset, enabled: false })}
          confirmLabel={t`Delete`}
        />
      ) : null}
    </div>
  );
}
