import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerProviderSettings as Settings } from "@rakazo/contracts";
import { parseMcpServerConfig } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SuccessPop } from "./ai/primitives";

type Draft = {
  provider: Settings["provider"];
  regionId: string;
  desktopId: string;
  endUserId: string;
  mcpUrl: string;
  accessKeyId: string;
  accessKeySecret: string;
  mcpToken: string;
};

// The RPC client hands out a new object on every property read, so pick by scope, never hold it.
function settingsApi(scope: "deployment" | "account") {
  return scope === "account" ? rpc.computerProvider.account : rpc.computerProvider;
}

function draftFrom(settings: Settings): Draft {
  return {
    provider: settings.provider,
    regionId: settings.wuying?.regionId ?? "",
    desktopId: settings.wuying?.desktopId ?? "",
    endUserId: settings.wuying?.endUserId ?? "",
    mcpUrl: settings.wuying?.mcpUrl ?? "",
    accessKeyId: "",
    accessKeySecret: "",
    mcpToken: "",
  };
}

/**
 * Where new computers run: an admin's choice for the deployment, or an account's own Wuying
 * desktop over that default. Wuying needs its desktop and gateway.
 */
export function ComputerProviderSettings({
  scope,
  onProviderChange,
}: {
  scope: "deployment" | "account";
  onProviderChange?: (sandboxProvider: string) => void;
}) {
  const { t } = useLingui();
  const selectId = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    settingsApi(scope)
      .get()
      .then((next) => {
        if (!alive) return;
        setSettings(next);
        setDraft(draftFrom(next));
      })
      .catch((caught: unknown) => {
        if (alive) setError(errorText(caught, t`Could not load computer settings`));
      });
    return () => {
      alive = false;
    };
  }, [scope, t]);

  if (!draft || !settings) {
    return error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null;
  }

  const set = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft({ ...draft, ...patch });
  };
  // The gateway's MCP client config, pasted into either field, fills in both.
  const setMcp = (field: "mcpUrl" | "mcpToken", value: string) => {
    const pasted = parseMcpServerConfig(value);
    if (pasted) set({ mcpUrl: pasted.url, mcpToken: pasted.token ?? draft.mcpToken });
    else set(field === "mcpUrl" ? { mcpUrl: value } : { mcpToken: value });
  };

  async function save() {
    if (!draft || pending) return;
    setPending(true);
    setError(null);
    try {
      const next = await settingsApi(scope).update(
        draft.provider === "default"
          ? { provider: "default" }
          : {
              provider: "wuying",
              wuying: {
                regionId: draft.regionId,
                desktopId: draft.desktopId,
                endUserId: draft.endUserId,
                mcpUrl: draft.mcpUrl,
                accessKeyId: draft.accessKeyId,
                accessKeySecret: draft.accessKeySecret,
                mcpToken: draft.mcpToken,
              },
            },
      );
      setSettings(next);
      setDraft(draftFrom(next));
      setSaved(true);
      onProviderChange?.(next.provider === "wuying" ? "wuying" : next.defaultProvider);
    } catch (caught) {
      setError(errorText(caught, t`Could not save computer settings`));
    } finally {
      setPending(false);
    }
  }

  const savedSecret = t`Saved`;
  const savedKey = Boolean(settings.wuying?.hasAccessKey);
  // The saved token goes only to the gateway it was saved for.
  const savedToken =
    Boolean(settings.wuying?.hasMcpToken) && draft.mcpUrl === settings.wuying?.mcpUrl;
  return (
    <form
      className="mt-4 grid gap-3"
      data-testid="computer-provider-settings"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field>
        <FieldLabel htmlFor={selectId}>
          <Trans>New computers run on</Trans>
        </FieldLabel>
        <NativeSelect
          id={selectId}
          value={draft.provider}
          onChange={(event) => set({ provider: event.target.value as Draft["provider"] })}
          className="w-full"
        >
          <NativeSelectOption value="default">
            {t`Deployment default (${settings.defaultProvider})`}
          </NativeSelectOption>
          <NativeSelectOption value="wuying">{t`Wuying cloud computer`}</NativeSelectOption>
        </NativeSelect>
      </Field>
      {draft.provider === "wuying" ? (
        <>
          <TextField
            label={t`Desktop ID`}
            value={draft.desktopId}
            onChange={(desktopId) => set({ desktopId })}
            required
          />
          <TextField
            label={t`End user ID`}
            value={draft.endUserId}
            onChange={(endUserId) => set({ endUserId })}
            required
          />
          <TextField
            label={t`Region`}
            value={draft.regionId}
            placeholder="cn-hangzhou"
            onChange={(regionId) => set({ regionId })}
          />
          <TextField
            label={t`AccessKey ID`}
            value={draft.accessKeyId}
            placeholder={savedKey ? savedSecret : undefined}
            onChange={(accessKeyId) => set({ accessKeyId })}
            required={!savedKey}
          />
          <TextField
            label={t`AccessKey secret`}
            value={draft.accessKeySecret}
            placeholder={savedKey ? savedSecret : undefined}
            onChange={(accessKeySecret) => set({ accessKeySecret })}
            required={!savedKey}
            secret
          />
          <TextField
            label={t`MCP gateway URL`}
            value={draft.mcpUrl}
            placeholder="https://"
            onChange={(mcpUrl) => setMcp("mcpUrl", mcpUrl)}
            type="url"
            required
          />
          <TextField
            label={t`MCP token`}
            value={draft.mcpToken}
            placeholder={savedToken ? savedSecret : undefined}
            onChange={(mcpToken) => setMcp("mcpToken", mcpToken)}
            required={!savedToken}
            secret
          />
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending && draft.provider === "wuying" ? <Trans>Checking…</Trans> : <Trans>Save</Trans>}
        </Button>
        {saved ? <SuccessPop label={t`Saved`} /> : null}
      </div>
    </form>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  required,
  secret,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
  type?: "text" | "url";
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={secret ? "password" : type}
        autoComplete={secret ? "off" : undefined}
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
