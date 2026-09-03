import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentSecret } from "@rakazo/contracts";
import { AGENT_SECRET_NAME_PATTERN } from "@rakazo/contracts";
import { Eye, EyeOff, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { BuiButton, BuiCard, SuccessPop } from "../components/beautiful-ui/primitives";
import { rpc } from "../lib/rpc";

export function AgentSecretsOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const [secrets, setSecrets] = useState<AgentSecret[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void rpc.agentSecrets
      .list()
      .then(setSecrets)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : t`Could not load secrets`),
      );
  }, []);

  async function save() {
    const normalizedName = name.trim();
    setError(null);
    setSaved(false);
    if (!AGENT_SECRET_NAME_PATTERN.test(normalizedName)) {
      setError(
        t`Use capital letters, numbers, and underscores; start with a letter or underscore.`,
      );
      return;
    }
    if (!value) {
      setError(t`Enter a secret value.`);
      return;
    }

    setSaving(true);
    try {
      const next = await rpc.agentSecrets.put({ name: normalizedName, value });
      setSecrets((current) =>
        [
          ...(current ?? []).filter((secret) => secret.id !== next.id && secret.name !== next.name),
          next,
        ].sort((left, right) => left.name.localeCompare(right.name)),
      );
      setName("");
      setValue("");
      setShowValue(false);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not save secret`);
    } finally {
      setSaving(false);
    }
  }

  async function remove(secret: AgentSecret) {
    if (confirmingDelete !== secret.id) {
      setConfirmingDelete(secret.id);
      return;
    }
    setError(null);
    setDeleting(secret.id);
    try {
      await rpc.agentSecrets.remove({ id: secret.id });
      setSecrets((current) => current?.filter((item) => item.id !== secret.id) ?? []);
      setConfirmingDelete(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not delete secret`);
    } finally {
      setDeleting(null);
    }
  }

  const busy = saving || deleting !== null;

  return (
    <div
      data-testid="agent-secrets-overlay"
      className="absolute inset-0 z-30 flex items-center justify-center bg-[rgba(4,4,5,.72)] p-4 sm:p-10"
    >
      <BuiCard className="flex max-h-[min(720px,100%)] w-[560px] max-w-full flex-col overflow-hidden rounded-lg border border-[#2A2A2F] bg-[#141416]">
        <header className="flex items-start justify-between border-b border-[#232326] px-6 py-5 sm:px-7">
          <div>
            <h1 className="text-[20px] font-medium text-[#F1F1F2]">
              <Trans>Secrets</Trans>
            </h1>
            <p className="mt-1 text-[13.5px] text-[#85858A]">
              <Trans>Available to every agent in this Space.</Trans>
            </p>
          </div>
          <button
            type="button"
            title={t`Close`}
            aria-label={t`Close secret settings`}
            disabled={busy}
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-md text-[#85858A] hover:bg-[#232327] hover:text-[#ECECEE] disabled:opacity-40"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-7">
          <section aria-labelledby="add-secret-heading">
            <h2 id="add-secret-heading" className="text-[14px] font-medium text-[#ECECEE]">
              <Trans>Add or replace</Trans>
            </h2>
            <div className="mt-3 grid gap-3">
              <label className="grid gap-1.5 text-[13px] text-[#A8A8AD]">
                <Trans>Name</Trans>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value.toUpperCase())}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="AUDIENTI_API_KEY"
                  className="h-10 rounded-md border border-[#2A2A2F] bg-[#0D0D0E] px-3 font-mono text-[13.5px] text-[#ECECEE] outline-none focus:border-[#62626A]"
                />
              </label>
              <label className="grid gap-1.5 text-[13px] text-[#A8A8AD]">
                <Trans>Secret value</Trans>
                <span className="relative block">
                  <input
                    type={showValue ? "text" : "password"}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    autoComplete="new-password"
                    className="h-10 w-full rounded-md border border-[#2A2A2F] bg-[#0D0D0E] px-3 pr-10 text-[13.5px] text-[#ECECEE] outline-none focus:border-[#62626A]"
                  />
                  <button
                    type="button"
                    title={showValue ? t`Hide value` : t`Show value`}
                    aria-label={showValue ? t`Hide value` : t`Show value`}
                    onClick={() => setShowValue((current) => !current)}
                    className="absolute inset-y-0 right-0 grid w-10 place-items-center text-[#85858A] hover:text-[#ECECEE]"
                  >
                    {showValue ? (
                      <EyeOff size={16} aria-hidden="true" />
                    ) : (
                      <Eye size={16} aria-hidden="true" />
                    )}
                  </button>
                </span>
              </label>
            </div>

            <div className="mt-4 flex min-h-9 items-center gap-3">
              <BuiButton onClick={() => void save()} disabled={busy} tone="accent">
                {saving ? <Trans>Saving…</Trans> : <Trans>Save secret</Trans>}
              </BuiButton>
              {saved ? <SuccessPop label={t`Saved`} /> : null}
            </div>
            {error ? (
              <p role="alert" className="mt-3 text-[13px] text-[#FF6B78]">
                {error}
              </p>
            ) : null}
          </section>

          <section aria-labelledby="configured-secrets-heading" className="mt-7">
            <h2 id="configured-secrets-heading" className="text-[14px] font-medium text-[#ECECEE]">
              <Trans>Configured</Trans>
            </h2>
            {secrets === null ? (
              <p className="mt-3 text-[13.5px] text-[#85858A]">
                <Trans>Loading…</Trans>
              </p>
            ) : secrets.length === 0 ? (
              <p className="mt-3 text-[13.5px] text-[#85858A]">
                <Trans>No secrets configured.</Trans>
              </p>
            ) : (
              <div className="mt-2 divide-y divide-[#232326] border-y border-[#232326]">
                {secrets.map((secret) => {
                  const confirming = confirmingDelete === secret.id;
                  return (
                    <div key={secret.id} className="flex min-h-12 items-center gap-3 py-2.5">
                      <code className="min-w-0 flex-1 truncate text-[13.5px] text-[#D8D8DC]">
                        {secret.name}
                      </code>
                      {confirming ? (
                        <button
                          type="button"
                          aria-label={t`Confirm delete ${secret.name}`}
                          disabled={busy}
                          onClick={() => void remove(secret)}
                          className="rounded-md px-2 py-1 text-[12.5px] text-[#FF6B78] hover:bg-[#2A181B] disabled:opacity-40"
                        >
                          <Trans>Delete?</Trans>
                        </button>
                      ) : null}
                      <button
                        type="button"
                        title={t`Delete ${secret.name}`}
                        aria-label={t`Delete ${secret.name}`}
                        disabled={busy}
                        onClick={() => void remove(secret)}
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[#85858A] hover:bg-[#2A181B] hover:text-[#FF6B78] disabled:opacity-40"
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </BuiCard>
    </div>
  );
}
