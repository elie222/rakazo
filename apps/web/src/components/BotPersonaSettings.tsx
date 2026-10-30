import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import { Button, Textarea } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

type RuntimeProfile = Awaited<ReturnType<typeof rpc.bots.runtimeProfileGet>>;

export function BotPersonaSettings({ botId }: { botId: string }) {
  const { t } = useLingui();
  const id = useId();
  const [profile, setProfile] = useState<RuntimeProfile | null>(null);
  const [persona, setPersona] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const next = await rpc.bots.runtimeProfileGet({ botId });
      setProfile(next);
      setPersona(next.settings.persona.persona);
      setConflict(false);
      setSaved(false);
    } catch (err) {
      setError(errorText(err, t`Could not load persona`));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // botId is the request identity. Loading again on every render would discard edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  async function save() {
    if (!profile || saving || conflict || persona === profile.settings.persona.persona) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const next = await rpc.bots.runtimeProfileUpdate({
        botId,
        expectedRevision: profile.revision,
        reason: t`Update persona`,
        settings: { ...profile.settings, persona: { ...profile.settings.persona, persona } },
      });
      setProfile(next);
      setPersona(next.settings.persona.persona);
      setConflict(false);
      setSaved(true);
    } catch (err) {
      setError(errorText(err, t`Could not save persona`));
      setConflict(err instanceof ORPCError && err.code === "CONFLICT");
    } finally {
      setSaving(false);
    }
  }

  const dirty = Boolean(profile && persona !== profile.settings.persona.persona);
  return (
    <section className="space-y-2" aria-busy={loading || saving}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`${id}-persona`} className="text-xs font-medium text-muted-foreground">
          <Trans>Persona</Trans>
        </label>
        {profile ? (
          <span className="text-xs text-muted-foreground">
            <Trans>Saved revision {profile.revision}</Trans>
          </span>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        <Trans>Describe the bot's style and point of view. This is separate from operational instructions.</Trans>
      </p>
      <Textarea
        id={`${id}-persona`}
        aria-label={t`Persona`}
        aria-describedby={`${id}-status`}
        className="min-h-24 resize-y"
        value={persona}
        maxLength={20_000}
        disabled={loading || saving || !profile || conflict}
        placeholder={t`Describe this bot's voice and perspective`}
        onChange={(event) => setPersona(event.target.value)}
      />
      <p className="text-sm text-muted-foreground">
        <Trans>Persona support is partial. Skill selection, extensions, learning, initiative, and routing are not active here.</Trans>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button className="min-h-11" disabled={!dirty || saving || loading || conflict} onClick={() => void save()}>
          {saving ? <Trans>Saving</Trans> : <Trans>Save persona</Trans>}
        </Button>
        {conflict ? (
          <Button className="min-h-11" variant="outline" disabled={loading || saving} onClick={() => void load()}>
            <Trans>Reload</Trans>
          </Button>
        ) : null}
        <span id={`${id}-status`} role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {loading ? <Trans>Loading persona</Trans> : null}
          {saved ? <Trans>Persona saved</Trans> : null}
        </span>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
