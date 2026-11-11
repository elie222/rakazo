import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Field, FieldError, FieldLabel, Input } from "@rakazo/ui-web";
import { useId, useState } from "react";
import type { ConnectionMode } from "./ConnectionModeFields";
import { ConnectionModeFields } from "./ConnectionModeFields";
import { MemoryProviderAdvanced } from "./MemoryProviderAdvanced";
import type { MemoryProviderConnectionDraft, MemoryProviderSettingsFormProps } from "./registry";

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{0,512}$/;
// Rakazo writes to these peers, so they cannot be read as the user's own peer.
function isReservedPeerId(value: string): boolean {
  return value === "rakazo-shared" || value.startsWith("bot-");
}

export function HonchoSettingsForm({
  busy,
  current,
  onConnect,
  advancedSettings,
}: MemoryProviderSettingsFormProps) {
  const { t } = useLingui();
  const editing = current !== undefined;
  const apiKeyId = useId();
  const workspaceId = useId();
  const workspaceErrorId = useId();
  const [mode, setMode] = useState<ConnectionMode>(current?.mode === "local" ? "local" : "cloud");
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? "");
  const userPeerId = useId();
  const userPeerErrorId = useId();
  const userPeerDescriptionId = useId();
  const [userPeer, setUserPeer] = useState(current?.userPeerId ?? "");
  const [apiKey, setApiKey] = useState("");
  const [workspace, setWorkspace] = useState(current?.workspaceId ?? "");
  const key = apiKey.trim();
  const workspaceValid = RESOURCE_ID_PATTERN.test(workspace.trim());
  const showUserPeer = workspace.trim().length > 0;
  const userPeerFormatValid = RESOURCE_ID_PATTERN.test(userPeer.trim());
  const userPeerReserved = isReservedPeerId(userPeer.trim());
  const userPeerValid = !showUserPeer || (userPeerFormatValid && !userPeerReserved);
  // Editing keeps the stored key only while the host, workspace and user peer are unchanged.
  const keepsKey =
    current !== undefined &&
    mode === (current.mode === "local" ? "local" : "cloud") &&
    (mode === "cloud" || baseUrl.trim() === (current.baseUrl ?? "").trim()) &&
    workspace.trim() === (current.workspaceId ?? "").trim() &&
    (showUserPeer ? userPeer.trim() : "") === (current.userPeerId ?? "").trim();
  const ready =
    (key.length === 0 ? keepsKey : key.length >= 8) &&
    workspaceValid &&
    userPeerValid &&
    (mode === "cloud" || Boolean(baseUrl.trim()));

  async function connect() {
    if (!ready) return;
    const draft: MemoryProviderConnectionDraft = {
      settings: {
        ...(mode === "local" ? { mode, baseUrl: baseUrl.trim() } : {}),
        ...(current?.reasoningLevel ? { reasoningLevel: current.reasoningLevel } : {}),
        ...(showUserPeer && userPeer.trim() ? { userPeerId: userPeer.trim() } : {}),
        ...(workspace.trim() ? { workspaceId: workspace.trim() } : {}),
      },
      credentials: key ? { apiKey: key } : {},
    };
    if (await onConnect(draft)) setApiKey("");
  }

  return (
    <>
      <Field className="mt-4">
        <FieldLabel htmlFor={apiKeyId}>
          <Trans>API key</Trans>
        </FieldLabel>
        <Input
          id={apiKeyId}
          value={apiKey}
          disabled={busy}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={keepsKey ? t`Saved` : mode === "cloud" ? "hch-…" : undefined}
          type="password"
          autoComplete="new-password"
          maxLength={4096}
        />
      </Field>

      <MemoryProviderAdvanced>
        {advancedSettings}
        <ConnectionModeFields
          busy={busy}
          mode={mode}
          onModeChange={setMode}
          baseUrl={baseUrl}
          onBaseUrlChange={setBaseUrl}
        />
        <Field className="mt-4" data-invalid={workspaceValid ? undefined : true}>
          <FieldLabel htmlFor={workspaceId}>
            <Trans>Workspace</Trans>
          </FieldLabel>
          <Input
            id={workspaceId}
            value={workspace}
            disabled={busy}
            aria-invalid={workspaceValid ? undefined : true}
            aria-describedby={workspaceValid ? undefined : workspaceErrorId}
            onChange={(event) => setWorkspace(event.target.value)}
            placeholder="rakazo-<space>"
            maxLength={512}
            autoComplete="off"
          />
          {!workspaceValid ? (
            <FieldError id={workspaceErrorId}>
              <Trans>Use up to 512 letters, digits, _ or -.</Trans>
            </FieldError>
          ) : null}
        </Field>

        {showUserPeer ? (
          <Field className="mt-4" data-invalid={userPeerValid ? undefined : true}>
            <FieldLabel htmlFor={userPeerId}>
              <Trans>User peer</Trans>
            </FieldLabel>
            <Input
              id={userPeerId}
              value={userPeer}
              disabled={busy}
              aria-invalid={userPeerValid ? undefined : true}
              aria-describedby={
                userPeerValid
                  ? userPeerDescriptionId
                  : `${userPeerDescriptionId} ${userPeerErrorId}`
              }
              onChange={(event) => setUserPeer(event.target.value)}
              maxLength={512}
              autoComplete="off"
            />
            <p id={userPeerDescriptionId} className="mt-2 text-body-sm text-muted-foreground">
              <Trans>Recall from this peer; save to Rakazo’s own peers.</Trans>
            </p>
            {!userPeerValid ? (
              <FieldError id={userPeerErrorId}>
                {userPeerFormatValid ? (
                  <Trans>rakazo-shared and IDs starting with bot- are reserved for Rakazo.</Trans>
                ) : (
                  <Trans>Use up to 512 letters, digits, _ or -.</Trans>
                )}
              </FieldError>
            ) : null}
          </Field>
        ) : null}
      </MemoryProviderAdvanced>

      <Button
        type="button"
        variant="secondary"
        className="mt-5"
        disabled={busy || !ready}
        onClick={() => void connect()}
      >
        {editing ? (
          busy ? (
            <Trans>Saving…</Trans>
          ) : (
            <Trans>Save</Trans>
          )
        ) : busy ? (
          <Trans>Connecting…</Trans>
        ) : (
          <Trans>Connect</Trans>
        )}
      </Button>
    </>
  );
}
