import { Trans, useLingui } from "@lingui/react/macro";
import type { SettingsScope } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useMemo } from "react";
import { ModelAccount } from "../../components/ModelAccount";
import { useSpaceQueries } from "../../lib/query/query";
import { useSpaceRpc } from "../../lib/query/space-rpc";
import { errorText } from "../../lib/query/user-error";
import { SpaceBotsModelButton } from "../model-settings/space-bots-model";
import { AccountI18n } from "./AccountI18n";
import { AccountModelRoleSettings as ModelRoleSettings } from "./AccountModelRoleSettings";
import { modelAccountConfigQuery, modelAccountStatusQuery } from "./queries";
import { useAuthorizationReturn } from "./use-authorization-return";

function ModelAccountSettingsContent({
  onClose,
  embedded = false,
  scope,
  onModelsChanged,
}: {
  onClose: () => void;
  embedded?: boolean;
  scope: SettingsScope;
  onModelsChanged?: () => void | Promise<void>;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const rpc = useSpaceRpc();
  const client = useQueryClient();
  const config = useQuery(modelAccountConfigQuery);
  const serviceName = config.data?.enabled ? config.data.serviceName : undefined;
  const authorizationTitle = serviceName
    ? t`Authorize access to ${serviceName} models`
    : t`Authorize model service`;
  const me = useQuery({ queryKey: queries.me.queryKey(), queryFn: () => rpc.me() });
  const credentials = useQuery({
    queryKey: queries.models.credentials.queryKey(),
    queryFn: () => rpc.models.credentials(),
  });
  const status = useQuery(modelAccountStatusQuery(me.data?.userId));
  useAuthorizationReturn(status.data, onClose);
  const managedCredentials = useMemo(
    () =>
      credentials.data?.filter((credential) => credential.id === status.data?.credentialId) ?? [],
    [credentials.data, status.data?.credentialId],
  );
  const refresh = async () => {
    await client.invalidateQueries();
    await onModelsChanged?.();
  };
  const failure = me.error ?? credentials.error ?? status.error;
  const needsAuthorization = !status.data?.connected || Boolean(status.data.recovery);
  const content = (
    <div data-testid="model-settings">
      {embedded && needsAuthorization ? (
        <SectionHeading className="mb-3">{authorizationTitle}</SectionHeading>
      ) : null}
      {scope === "account" || !status.data?.connected || status.data.recovery ? (
        <ModelAccount required onChanged={refresh} />
      ) : null}
      {failure ? (
        <p role="alert" className="text-body text-destructive">
          {errorText(failure)}
        </p>
      ) : null}
      {status.data?.connected && me.data && credentials.data ? (
        <>
          <ModelRoleSettings
            userId={me.data.userId}
            spaceId={me.data.spaceId}
            scope={scope}
            credentials={managedCredentials}
            title={t`Main model`}
            defaultLabel={t`Choose a model`}
            thinking
            onChanged={() => void refresh()}
          />
          {me.data.needsModel ? null : (
            <SpaceBotsModelButton mainModelKey={`${me.data.spaceId}:${me.data.defaultModel}`} />
          )}
          <ModelRoleSettings
            userId={me.data.userId}
            spaceId={me.data.spaceId}
            scope={scope}
            credentials={managedCredentials}
            modelRole="approval"
            title={t`Approval model`}
            defaultLabel={t`Choose a model`}
            onChanged={() => void refresh()}
          />
        </>
      ) : null}
    </div>
  );
  if (embedded) return content;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={
          needsAuthorization
            ? "max-h-[calc(100%-2rem)] flex flex-col rounded-lg sm:max-w-lg p-0"
            : "max-h-[calc(100%-2rem)] flex flex-col max-w-xl p-0"
        }
      >
        <DialogHeader
          className={
            needsAuthorization
              ? "flex-row items-start justify-between px-6 pt-5"
              : "flex-row items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7"
          }
        >
          <DialogTitle
            className={
              needsAuthorization
                ? "text-heading3 font-semibold leading-6 text-foreground"
                : "text-heading2 font-medium text-foreground"
            }
          >
            {needsAuthorization ? authorizationTitle : <Trans>Models</Trans>}
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close model settings`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
        <div
          className={
            needsAuthorization
              ? "overflow-y-auto px-6 pb-5"
              : "overflow-y-auto px-6 pb-6 sm:px-8 sm:pb-8"
          }
        >
          {content}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ModelAccountSettings(props: Parameters<typeof ModelAccountSettingsContent>[0]) {
  return (
    <AccountI18n>
      <ModelAccountSettingsContent {...props} />
    </AccountI18n>
  );
}
